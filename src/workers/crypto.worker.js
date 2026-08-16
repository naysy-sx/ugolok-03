import * as Comlink from "comlink";
import { verify } from "../core/crypto/sign.js";
import { encryptChunk } from "../domain/files/crypto.js";

const api = {
  batchVerify(events) {
    return events.map((event) => verify(event));
  },
  // Медиа-подсистема, этап C — потоковая загрузка чанков файла (CPU-bound
  // ChaCha20-Poly1305) вне главного потока, тот же приём, что batchVerify.
  encryptChunk(chunkBytes, fileKey, chunkIndex) {
    return encryptChunk(chunkBytes, fileKey, chunkIndex);
  },
};

Comlink.expose(api);
