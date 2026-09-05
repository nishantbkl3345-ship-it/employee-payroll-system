import type { MultipartFile } from '@fastify/multipart';
import type { SendOptions } from '@fastify/static';

/**
 * npm hoists @fastify/multipart and @fastify/static to the workspace root but
 * keeps fastify itself under server/node_modules, so the plugins' own
 * `declare module 'fastify'` blocks resolve to nothing. Declaring the two
 * members we use from inside this package targets the right module.
 */
declare module 'fastify' {
  interface FastifyRequest {
    file(options?: Record<string, unknown>): Promise<MultipartFile | undefined>;
  }

  interface FastifyReply {
    sendFile(filename: string, options?: SendOptions): FastifyReply;
  }
}
