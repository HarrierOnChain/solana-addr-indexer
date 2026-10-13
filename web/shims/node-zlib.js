// Browser stand-in for node:zlib's callback-style inflate (zlib format),
// built on the native DecompressionStream.
import { Buffer } from 'node:buffer';

export function inflate(data, callback) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  new Response(stream)
    .arrayBuffer()
    .then((buf) => callback(null, Buffer.from(buf)), (err) => callback(err));
}
