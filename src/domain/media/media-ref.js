export function classOf(mime) {
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return "other";
}

function base64ToBytes(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function refFromAttachment(attachment, sourceMeta) {
  return {
    digest: attachment.manifestDigest,
    key: base64ToBytes(attachment.fileKey),
    mime: attachment.mime,
    name: attachment.name,
    size: attachment.size,
    sourceKind: "attachment",
    sourceMeta: sourceMeta
  };
}

export function refFromNode(node, mime, key, size) {
  return {
    digest: node.blob,
    key: key,
    mime: mime,
    name: node.name.value,
    size: size,
    sourceKind: "node",
    sourceMeta: { nodeId: node.id }
  };
}
