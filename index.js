import fastify from 'fastify';
import fastifyBabel from 'fastify-babel';
import fastifyStatic from 'fastify-static';
import fastifyHttpProxy from 'fastify-http-proxy';

export class FastifyIntegrationDaemon {
	constructor(fastifyOptions) {
		this.daemon = fastify(fastifyOptions);
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
