import * as Comlink from "comlink";
import { verify } from "../core/crypto/sign.js";

const api = {
  batchVerify(events) {
    return events.map((event) => verify(event));
  },
};

Comlink.expose(api);
