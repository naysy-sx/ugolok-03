// Единственный статический импорт "?worker&inline" в domain-слое — ТОЛЬКО
// здесь, и этот файл сам грузится ЛЕНИВО (динамическим import()) из
// stream-upload.js, никогда статически (CONTRACTS.md, "Этап C" —
// ?worker&inline не резолвится под node --test).
import * as Comlink from "comlink";
import CryptoWorker from "../../workers/crypto.worker.js?worker&inline";

// Ленивый собственный синглтон — НЕ переиспользует worker transport.js
// (тот приватный, привязан к жизненному циклу подключения; домен не
// полагается на UI-состояние). Создаётся при первом реальном вызове,
// живёт до конца вкладки (дёшев, используется редко — не завершается явно).
let workerApi = null;
function getWorkerApi() {
	if (!workerApi) workerApi = Comlink.wrap(new CryptoWorker());
	return workerApi;
}

export async function encryptChunkRemote(chunkBytes, fileKey, chunkIndex) {
	return getWorkerApi().encryptChunk(chunkBytes, fileKey, chunkIndex);
}
