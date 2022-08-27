import fastify from 'fastify';
import fastifyBabel from 'fastify-babel';
import fastifyStatic from '@fastify/static';
import fastifyHttpProxy from '@fastify/http-proxy';
import fastifyWebSocket from '@fastify/websocket';
import WebSocket from 'ws';

function forwardWSHeaders(headers) {
    const ignoreStrings = new Set(['host', 'upgrade', 'connection']);
    const ignoreHeaders = [
        {
            test: id => ignoreStrings.has(id)
        },
        {
            test: id => id.startsWith('sec-')
        }
    ];

    for (const id of Object.keys(headers)) {
        if (ignoreHeaders.some(matcher => matcher.test(id))) {
            delete headers[id];
        }
    }

    return headers;
}

// Begin copied from fastify-http-proxy
function liftErrorCode(code) {
    if (typeof code !== 'number') {
        // Sometimes "close" event emits with a non-numeric value
        return 1011;
    }

    switch (code) {
        case 1004:
        case 1005:
        case 1006:
            // ws module forbid those error codes usage, lift to "application level" (4xxx)
            return 4000 + (code % 1000);
        default:
            return code;
    }
}

function closeWebSocket(socket, code, reason) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.close(liftErrorCode(code), reason);
    }
}

function waitConnection(socket, write) {
    if (socket.readyState === WebSocket.CONNECTING) {
        socket.once('open', write);
    } else {
        write();
    }
}

function proxyWebSockets(source, target) {
    function close(code, reason) {
        closeWebSocket(source, code, reason);
        closeWebSocket(target, code, reason);
    }

    source.on('message', data => waitConnection(target, () => target.send(data)));
    source.on('ping', data => waitConnection(target, () => target.ping(data)));
    source.on('pong', data => waitConnection(target, () => target.pong(data)));
    source.on('close', close);
    source.on('error', error => close(1011, error.message));
    source.on('unexpected-response', () => close(1011, 'unexpected response'));

    // source WebSocket is already connected because it is created by ws server
    target.on('message', data => source.send(data));
    target.on('ping', data => source.ping(data));
    target.on('pong', data => source.pong(data));
    target.on('close', close);
    target.on('error', error => close(1011, error.message));
    target.on('unexpected-response', () => close(1011, 'unexpected response'));
}
// End copied from fastify-http-proxy

export class FastifyIntegrationDaemon {
    constructor(fastifyOptions) {
        this.daemon = fastify(fastifyOptions);
        this.daemon.register(fastifyWebSocket);
    }

    serveProxy({prefix, upstream, onResponse}) {
        const replyOptions = onResponse ? {onResponse} : undefined;
        this.daemon.register(fastifyHttpProxy, {
            upstream: `${upstream}${prefix}`,
            prefix,
            replyOptions
        });

        return this;
    }

    forwardWS({path, destination, forwardHeaders = forwardWSHeaders}) {
        this.daemon.get(path, {websocket: true}, (connection, request) => {
            const upstream = new WebSocket(destination, {
                headers: forwardHeaders({...request.headers})
            });

            proxyWebSockets(connection.socket, upstream);
        });

        return this;
    }

    serveBuilt({prefix, root}) {
        this.daemon.register((fastify, options, next) => {
            fastify
                .register(fastifyStatic, {
                    root,
                    redirect: true
                })
                .setNotFoundHandler((_, reply) => reply.sendFile('index.html'));

            next();
        }, {prefix});

        return this;
    }

    serveSource({prefix, root, manifest, nodeModules, babelrc}) {
        const babelCache = new Map();
        this.daemon.get('/purge-cache', (_, reply) => {
            const message = `Cleared ${babelCache.size} entries`;
            babelCache.clear();
            console.log(message);
            reply.send(`${message}\n`);
        });

        this.daemon.register((fastify, options, next) => {
            fastify
                .register((fastify, options, next) => {
                    fastify.register(fastifyStatic, {
                        root,
                        redirect: true
                    });
                    fastify.get('/manifest.webmanifest', (_, reply) => reply.send(manifest));
                    fastify.setNotFoundHandler((_, reply) => reply.sendFile('index.html'));

                    next();
                }, {prefix})
                .register(fastifyStatic, {
                    prefix: '/node_modules',
                    root: nodeModules,
                    decorateReply: false
                })
                .register(fastifyBabel, {
                    babelrc,
                    maskError: false,
                    cache: babelCache
                });

            next();
        });

        return this;
    }

    listen(...args) {
        return this.daemon.listen(...args);
    }

    unref() {
        this.daemon.server.unref();
    }

    address() {
        return this.daemon.server.address();
    }
}
