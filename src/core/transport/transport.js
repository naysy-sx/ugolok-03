export function createEndpointList(urls) {
  if (!urls || urls.length === 0) {
    throw new Error("createEndpointList: список endpoint не может быть пустым");
  }
  let index = 0;
  return {
    current() {
      return urls[index];
    },
    next() {
      index = (index + 1) % urls.length;
      return urls[index];
    },
    reset() {
      index = 0;
    },
  };
}
