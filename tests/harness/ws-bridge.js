import { WebSocketServer } from "ws";

export function createWsBridge(relay, { port = 0 } = {}) {
  let wss = null;
  let nextConnId = 1;
  const sockets = new Map();

  function start() {
    return new Promise((resolve) => {
      wss = new WebSocketServer({ port });
      wss.on("connection", (ws) => {
        const connId = `conn${nextConnId++}`;
        sockets.set(connId, ws);

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          const [type, ...rest] = msg;
          if (type === "EVENT") relay.publish(connId, rest[0]);
          else if (type === "REQ") relay.subscribe(connId, rest[0], rest.slice(1));
          else if (type === "CLOSE") relay.unsubscribe(connId, rest[0]);
        });

        ws.on("close", () => {
          sockets.delete(connId);
          relay.disconnect(connId);
        });
      });
      wss.on("listening", () => resolve({ port: wss.address().port }));
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!wss) return resolve();
      // wss.close() сам по себе НЕ закрывает уже открытые клиентские сокеты
      // (документированное поведение — ждёт естественного закрытия), поэтому
      // без явного terminate() зависший/недоуправляемый девайс-процесс мог бы
      // повесить stop() навсегда — недопустимо для харнесса, который обязан
      // переживать падающие сценарии.
      for (const ws of sockets.values()) ws.terminate();
      sockets.clear();
      wss.close(() => resolve());
    });
  }

  function deliver(connId, msg) {
    const ws = sockets.get(connId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  return { start, stop, deliver };
}
