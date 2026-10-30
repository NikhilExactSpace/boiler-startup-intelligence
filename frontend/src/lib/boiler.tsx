import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api } from "./api";
import type { BoilerSummary } from "./types";

interface BoilerContextValue {
  boilers: BoilerSummary[];
  boilerId: string;
  boiler: BoilerSummary | null;
  loading: boolean;
  error: string | null;
  setBoilerId: (id: string) => void;
  refresh: () => Promise<void>;
}

const BoilerContext = createContext<BoilerContextValue | null>(null);
const STORAGE_KEY = "bsi.boiler";

export function BoilerProvider({ children }: { children: ReactNode }) {
  const [boilers, setBoilers] = useState<BoilerSummary[]>([]);
  const [boilerId, setBoilerIdState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "B-101",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.boilers();
      setBoilers(rows);
      setError(null);
      setBoilerIdState((current) => {
        if (rows.some((row) => row.id === current)) return current;
        return rows[0]?.id ?? current;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load boilers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setBoilerId = useCallback((id: string) => {
    setBoilerIdState(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  useEffect(() => {
    if (boilerId) localStorage.setItem(STORAGE_KEY, boilerId);
  }, [boilerId]);

  const boiler = useMemo(
    () => boilers.find((row) => row.id === boilerId) ?? null,
    [boilers, boilerId],
  );

  const value = useMemo(
    () => ({ boilers, boilerId, boiler, loading, error, setBoilerId, refresh }),
    [boilers, boilerId, boiler, loading, error, setBoilerId, refresh],
  );

  return <BoilerContext.Provider value={value}>{children}</BoilerContext.Provider>;
}

export function useBoiler(): BoilerContextValue {
  const context = useContext(BoilerContext);
  if (!context) throw new Error("useBoiler must be used inside BoilerProvider");
  return context;
}
