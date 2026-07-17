import { useState, useEffect } from "preact/hooks";

export const ROUTES = ["/onboarding", "/main", "/unlock"];
export const DEFAULT_ROUTE = "/main";

export function parseRoute(hash) {
  const trimmedHash = hash.replace(/^#/, '');
  return ROUTES.includes(trimmedHash) ? trimmedHash : DEFAULT_ROUTE;
}

export function useRoute() {
  const [route, setRoute] = useState(parseRoute(location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

export function navigate(path) {
  location.hash = path;
}
