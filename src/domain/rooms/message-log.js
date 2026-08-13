// Rooms message-log — адаптивная вставка с хвоста для сообщений чата, ROOMS-ALGO §5

function compare(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function createLog({ maxBacktrack = 200 }) {
  const idSet = new Set();
  const arr = [];

  function insert(msg) {
    if (idSet.has(msg.id)) return false;
    idSet.add(msg.id);
    let pos = arr.length;
    let steps = 0;
    while (pos > 0 && steps < maxBacktrack && compare(arr[pos - 1], msg) > 0) {
      pos -= 1;
      steps += 1;
    }
    arr.splice(pos, 0, msg);
    return true;
  }

  function toArray() {
    return arr.slice();
  }

  return { insert, toArray };
}
