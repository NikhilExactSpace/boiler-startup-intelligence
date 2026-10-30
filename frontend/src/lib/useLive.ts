import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";
import type { LiveSnapshot } from "./types";

export function useLive(boilerId: string, startupType = "auto") {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const polling = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (polling.current !== null) {
      window.clearInterval(polling.current);
      polling.current = null;
    }
  }, []);

  const apply = useCallback((next: LiveSnapshot) => {
    setSnapshot(next);
    setError(null);
  }, []);

  useEffect(() => {
    let disposed = false;
    stopPolling();

    const refresh = () => {
      api
        .live(boilerId, startupType)
        .then((data) => {
          if (!disposed) apply(data);
        })
        .catch((caught) => {
          if (!disposed) setError(caught instanceof Error ? caught.message : "Live feed unavailable");
        });
    };

    refresh();

    const source = new EventSource(api.liveStreamUrl(boilerId, startupType));
    source.onopen = () => {
      if (!disposed) {
        setConnected(true);
        stopPolling();
      }
    };
    source.onmessage = (event) => {
      if (disposed) return;
      try {
        apply(JSON.parse(event.data) as LiveSnapshot);
        setConnected(true);
      } catch {
        /* ignore malformed frame */
      }
    };
    source.onerror = () => {
      if (disposed) return;
      setConnected(false);
      source.close();
      if (polling.current === null) {
        polling.current = window.setInterval(refresh, 2500);
      }
    };

    return () => {
      disposed = true;
      source.close();
      stopPolling();
    };
  }, [boilerId, startupType, apply, stopPolling]);

  const restart = useCallback(async () => {
    setRestarting(true);
    setError(null);
    try {
      const response = await api.restartLive(boilerId, startupType);
      apply(response.snapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restart the replay");
    } finally {
      setRestarting(false);
    }
  }, [boilerId, startupType, apply]);

  const retry = useCallback(() => {
    api
      .live(boilerId, startupType)
      .then(apply)
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Live feed unavailable"),
      );
  }, [boilerId, apply]);

  return { snapshot, error, connected, restarting, restart, retry };
}
