/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  StatusCode,
  context,
  propagation,
  Span,
  SpanKind,
  SpanOptions,
  Status,
} from '@opentelemetry/api';
import { RpcAttribute } from '@opentelemetry/semantic-conventions';
import * as events from 'events';
import * as grpcTypes from 'grpc';
import {
  grpc,
  GrpcClientFunc,
  GrpcInternalClientTypes,
  GrpcInstrumentationOptions,
  ModuleExportsMapping,
  SendUnaryDataCallback,
  ServerCallWithMeta,
} from './types';
import {
  findIndex,
  _grpcStatusCodeToOpenTelemetryStatusCode,
  _grpcStatusCodeToSpanStatus,
  _methodIsIgnored,
} from './utils';
import { VERSION } from './version';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';

/** The metadata key under which span context is stored as a binary value. */
export const GRPC_TRACE_KEY = 'grpc-trace-bin';

let grpcClientModule: GrpcInternalClientTypes;

export class GrpcInstrumentation extends InstrumentationBase<grpc> {
  constructor(config: GrpcInstrumentationOptions) {
    super(
      '@opentelemetry/instrumentation-grpc',
      VERSION,
      Object.assign({}, config)
    );
  }

  protected setConfig(config: GrpcInstrumentationOptions) {
    this._config = Object.assign({}, config);
  }

  init() {
    const module = new InstrumentationNodeModuleDefinition<grpc>(
      'grpc',
      ['1.*'],
      this.patch.bind(this),
      this.unpatch.bind(this)
    );

    const client = new InstrumentationNodeModuleFile<grpc>(
      'grpc/src/client',
      moduleExports => {
        return this._wrap(
          moduleExports,
          'makeClientConstructor',
          this._patchClient()
        );
      },
      moduleExports => {
        this._unwrap(moduleExports, 'makeClientConstructor');
      }
    );

    module.files.push(client);

    return module;
  }

  protected readonly _internalFilesList: ModuleExportsMapping = {
    '0.13 - 1.6': { client: 'src/node/src/client.js' },
    '^1.7': { client: 'src/client.js' },
  };

  protected patch(moduleExports: grpc): typeof grpcTypes {
    this._logger.debug(
      'applying patch to %s@%s',
      this.instrumentationName,
      this.instrumentationVersion
    );

    if (moduleExports.Server) {
      this._wrap(
        moduleExports.Server.prototype,
        'register',
        this._patchServer() as any
      );
    }

    // Wrap the externally exported client constructor
    this._wrap(
      moduleExports,
      'makeGenericClientConstructor',
      this._patchClient()
    );

    if (this._internalFilesExports['client']) {
      grpcClientModule = this._internalFilesExports[
        'client'
      ] as GrpcInternalClientTypes;

      // Wrap the internally used client constructor
      this._wrap(
        grpcClientModule,
        'makeClientConstructor',
        this._patchClient()
      );
    }

    return moduleExports;
  }
  protected unpatch(moduleExports: grpc): void {
    this._logger.debug(
      'removing patch to %s@%s',
      this.instrumentationName,
      this.instrumentationVersion
    );

    if (moduleExports.Server) {
      this._unwrap(moduleExports.Server.prototype, 'register');
    }

    this._unwrap(moduleExports, 'makeGenericClientConstructor');

    if (grpcClientModule) {
      this._unwrap(grpcClientModule, 'makeClientConstructor');
    }
  }

  private _setSpanContext(metadata: grpcTypes.Metadata): void {
    propagation.inject(metadata, {
      set: (metadata, k, v) => metadata.set(k, v as grpcTypes.MetadataValue),
    });
  }

  private _patchServer() {
    return (originalRegister: typeof grpcTypes.Server.prototype.register) => {
      const plugin = this;
      plugin._logger.debug('patched gRPC server');

      return function register<RequestType, ResponseType>(
        this: grpcTypes.Server & { handlers: any },
        name: string,
        handler: grpcTypes.handleCall<RequestType, ResponseType>,
        serialize: grpcTypes.serialize<RequestType>,
        deserialize: grpcTypes.deserialize<RequestType>,
        type: string
      ) {
        const originalResult = originalRegister.apply(this, arguments as any);
        const handlerSet = this.handlers[name];

        plugin._wrap(
          handlerSet,
          'func',
          (originalFunc: grpcTypes.handleCall<RequestType, ResponseType>) => {
            return function func(
              this: typeof handlerSet,
              call: ServerCallWithMeta,
              callback: SendUnaryDataCallback
            ) {
              const self = this;
              if (plugin._shouldNotTraceServerCall(call, name)) {
                switch (type) {
                  case 'unary':
                  case 'client_stream':
                    return (originalFunc as Function).call(
                      self,
                      call,
                      callback
                    );
                  case 'server_stream':
                  case 'bidi':
                    return (originalFunc as Function).call(self, call);
                  default:
                    return originalResult;
                }
              }
              const spanName = `grpc.${name.replace('/', '')}`;
              const spanOptions: SpanOptions = {
                kind: SpanKind.SERVER,
              };

              plugin._logger.debug(
                'patch func: %s',
                JSON.stringify(spanOptions)
              );

              context.with(
                propagation.extract(call.metadata, {
                  get: (metadata, key) => metadata.get(key).map(String),
                  keys: metadata => Object.keys(metadata.getMap()),
                }),
                () => {
                  const span = plugin.tracer
                    .startSpan(spanName, spanOptions)
                    .setAttributes({
                      [RpcAttribute.GRPC_KIND]: spanOptions.kind,
                    });

                  plugin.tracer.withSpan(span, () => {
                    switch (type) {
                      case 'unary':
                      case 'client_stream':
                        return plugin._clientStreamAndUnaryHandler(
                          plugin,
                          span,
                          call,
                          callback,
                          originalFunc,
                          self
                        );
                      case 'server_stream':
                      case 'bidi':
                        return plugin._serverStreamAndBidiHandler(
                          plugin,
                          span,
                          call,
                          originalFunc,
                          self
                        );
                      default:
                        break;
                    }
                  });
                }
              );
            };
          }
        );

        return originalResult;
      };
    };
  }

  /**
   * Returns true if the server call should not be traced.
   */
  private _shouldNotTraceServerCall(
    call: ServerCallWithMeta,
    name: string
  ): boolean {
    const parsedName = name.split('/');
    return _methodIsIgnored(
      parsedName[parsedName.length - 1] || name,
      this._config.ignoreGrpcMethods
    );
  }

  private _clientStreamAndUnaryHandler<RequestType, ResponseType>(
    plugin: GrpcInstrumentation,
    span: Span,
    call: ServerCallWithMeta,
    callback: SendUnaryDataCallback,
    original:
      | grpcTypes.handleCall<RequestType, ResponseType>
      | grpcTypes.ClientReadableStream<RequestType>,
    self: {}
  ) {
    function patchedCallback(
      err: grpcTypes.ServiceError,
      value: any,
      trailer: grpcTypes.Metadata,
      flags: grpcTypes.writeFlags
    ) {
      if (err) {
        if (err.code) {
          span.setStatus({
            code: _grpcStatusCodeToOpenTelemetryStatusCode(err.code),
            message: err.message,
          });
          span.setAttribute(RpcAttribute.GRPC_STATUS_CODE, err.code.toString());
        }
        span.setAttributes({
          [RpcAttribute.GRPC_ERROR_NAME]: err.name,
          [RpcAttribute.GRPC_ERROR_MESSAGE]: err.message,
        });
      } else {
        span.setStatus({ code: StatusCode.OK });
        span.setAttribute(
          RpcAttribute.GRPC_STATUS_CODE,
          plugin._moduleExports.status.OK.toString()
        );
      }
      span.addEvent('received');

      // end the span
      span.end();
      return callback(err, value, trailer, flags);
    }

    plugin.tracer.bind(call);
    return (original as Function).call(self, call, patchedCallback);
  }

  private _serverStreamAndBidiHandler<RequestType, ResponseType>(
    plugin: GrpcInstrumentation,
    span: Span,
    call: ServerCallWithMeta,
    original: grpcTypes.handleCall<RequestType, ResponseType>,
    self: {}
  ) {
    let spanEnded = false;
    const endSpan = () => {
      if (!spanEnded) {
        spanEnded = true;
        span.end();
      }
    };

    plugin.tracer.bind(call);
    call.on('finish', () => {
      span.setStatus(_grpcStatusCodeToSpanStatus(call.status.code));
      span.setAttribute(
        RpcAttribute.GRPC_STATUS_CODE,
        call.status.code.toString()
      );

      // if there is an error, span will be ended on error event, otherwise end it here
      if (call.status.code === 0) {
        span.addEvent('finished');
        endSpan();
      }
    });

    call.on('error', (err: grpcTypes.ServiceError) => {
      span.setStatus({
        code: _grpcStatusCodeToOpenTelemetryStatusCode(err.code),
        message: err.message,
      });
      span.addEvent('finished with error');
      span.setAttributes({
        [RpcAttribute.GRPC_ERROR_NAME]: err.name,
        [RpcAttribute.GRPC_ERROR_MESSAGE]: err.message,
      });
      endSpan();
    });

    return (original as any).call(self, call);
  }

  private _patchClient() {
    const plugin = this;
    return (original: typeof grpcTypes.makeGenericClientConstructor): never => {
      plugin._logger.debug('patching client');
      return function makeClientConstructor(
        this: typeof grpcTypes.Client,
        methods: { [key: string]: { originalName?: string } },
        _serviceName: string,
        _options: grpcTypes.GenericClientOptions
      ) {
        const client = original.apply(this, arguments as any);
        plugin._massWrap(
          client.prototype as never,
          plugin._getMethodsToWrap(client, methods) as never[],
          plugin._getPatchedClientMethods() as any
        );
        return client;
      } as never;
    };
  }

  private _getMethodsToWrap(
    client: typeof grpcTypes.Client,
    methods: { [key: string]: { originalName?: string } }
  ): string[] {
    const methodList: string[] = [];

    // For a method defined in .proto as "UnaryMethod"
    Object.entries(methods).forEach(([name, { originalName }]) => {
      if (!_methodIsIgnored(name, this._config.ignoreGrpcMethods)) {
        methodList.push(name); // adds camel case method name: "unaryMethod"
        if (
          originalName &&
          // eslint-disable-next-line no-prototype-builtins
          client.prototype.hasOwnProperty(originalName) &&
          name !== originalName // do not add duplicates
        ) {
          // adds original method name: "UnaryMethod",
          methodList.push(originalName);
        }
      }
    });
    return methodList;
  }

  private _getPatchedClientMethods() {
    const plugin = this;
    return (original: GrpcClientFunc) => {
      plugin._logger.debug('patch all client methods');
      return function clientMethodTrace(this: grpcTypes.Client) {
        const name = `grpc.${original.path.replace('/', '')}`;
        const args = Array.prototype.slice.call(arguments);
        const metadata = plugin._getMetadata(original, args);
        const span = plugin.tracer.startSpan(name, {
          kind: SpanKind.CLIENT,
        });
        return plugin.tracer.withSpan(span, () =>
          plugin._makeGrpcClientRemoteCall(
            original,
            args,
            metadata,
            this,
            plugin
          )(span)
        );
      };
    };
  }

  /**
   * This method handles the client remote call
   */
  private _makeGrpcClientRemoteCall(
    original: GrpcClientFunc,
    args: any[],
    metadata: grpcTypes.Metadata,
    self: grpcTypes.Client,
    plugin: GrpcInstrumentation
  ) {
    /**
     * Patches a callback so that the current span for this trace is also ended
     * when the callback is invoked.
     */
    function patchedCallback(
      span: Span,
      callback: SendUnaryDataCallback,
      _metadata: grpcTypes.Metadata
    ) {
      const wrappedFn = (err: grpcTypes.ServiceError, res: any) => {
        if (err) {
          if (err.code) {
            span.setStatus(_grpcStatusCodeToSpanStatus(err.code));
            span.setAttribute(
              RpcAttribute.GRPC_STATUS_CODE,
              err.code.toString()
            );
          }
          span.setAttributes({
            [RpcAttribute.GRPC_ERROR_NAME]: err.name,
            [RpcAttribute.GRPC_ERROR_MESSAGE]: err.message,
          });
        } else {
          span.setStatus({ code: StatusCode.OK });
          span.setAttribute(
            RpcAttribute.GRPC_STATUS_CODE,
            plugin._moduleExports.status.OK.toString()
          );
        }

        span.end();
        callback(err, res);
      };
      return plugin.tracer.bind(wrappedFn);
    }

    return (span: Span) => {
      if (!span) {
        return original.apply(self, args);
      }

      // if unary or clientStream
      if (!original.responseStream) {
        const callbackFuncIndex = findIndex(args, arg => {
          return typeof arg === 'function';
        });
        if (callbackFuncIndex !== -1) {
          args[callbackFuncIndex] = patchedCallback(
            span,
            args[callbackFuncIndex],
            metadata
          );
        }
      }

      span.addEvent('sent');
      span.setAttributes({
        [RpcAttribute.GRPC_METHOD]: original.path,
        [RpcAttribute.GRPC_KIND]: SpanKind.CLIENT,
      });

      this._setSpanContext(metadata);
      const call = original.apply(self, args);

      // if server stream or bidi
      if (original.responseStream) {
        // Both error and status events can be emitted
        // the first one emitted set spanEnded to true
        let spanEnded = false;
        const endSpan = () => {
          if (!spanEnded) {
            span.end();
            spanEnded = true;
          }
        };
        plugin.tracer.bind(call);
        ((call as unknown) as events.EventEmitter).on(
          'error',
          (err: grpcTypes.ServiceError) => {
            span.setStatus({
              code: _grpcStatusCodeToOpenTelemetryStatusCode(err.code),
              message: err.message,
            });
            span.setAttributes({
              [RpcAttribute.GRPC_ERROR_NAME]: err.name,
              [RpcAttribute.GRPC_ERROR_MESSAGE]: err.message,
            });
            endSpan();
          }
        );

        ((call as unknown) as events.EventEmitter).on(
          'status',
          (status: Status) => {
            span.setStatus({ code: StatusCode.OK });
            span.setAttribute(
              RpcAttribute.GRPC_STATUS_CODE,
              status.code.toString()
            );
            endSpan();
          }
        );
      }
      return call;
    };
  }

  private _getMetadata(
    original: GrpcClientFunc,
    args: any[]
  ): grpcTypes.Metadata {
    let metadata: grpcTypes.Metadata;

    // This finds an instance of Metadata among the arguments.
    // A possible issue that could occur is if the 'options' parameter from
    // the user contains an '_internal_repr' as well as a 'getMap' function,
    // but this is an extremely rare case.
    let metadataIndex = findIndex(args, (arg: any) => {
      return (
        arg &&
        typeof arg === 'object' &&
        arg._internal_repr &&
        typeof arg.getMap === 'function'
      );
    });
    if (metadataIndex === -1) {
      metadata = new this._moduleExports.Metadata();
      if (!original.requestStream) {
        // unary or server stream
        if (args.length === 0) {
          // No argument (for the gRPC call) was provided, so we will have to
          // provide one, since metadata cannot be the first argument.
          // The internal representation of argument defaults to undefined
          // in its non-presence.
          // Note that we can't pass null instead of undefined because the
          // serializer within gRPC doesn't accept it.
          args.push(undefined);
        }
        metadataIndex = 1;
      } else {
        // client stream or bidi
        metadataIndex = 0;
      }
      args.splice(metadataIndex, 0, metadata);
    } else {
      metadata = args[metadataIndex];
    }
    return metadata;
  }
}
