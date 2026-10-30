import { useEffect, useState } from "react";

import { api } from "./api";
import type { Health } from "./types";

let cache: Health | null = null;
let inflight: Promise<Health> | null = null;

async function loadHealth(): Promise<Health> {
  if (cache) return cache;
  if (!inflight) {
    inflight = api
      .health()
      .then((data) => {
        cache = data;
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadHealth()
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Backend unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { health, error };
}
