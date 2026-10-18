import { useState, useEffect, useRef, useCallback } from "react";
import { useNodeData } from "@/contexts/NodeDataContext";
import type { PingHistoryResponse, NodeData } from "@/types/node";
import type { HistoryQueryRange } from "@/services/api";
import {
  resolveHistoryBounds,
  type HistoryBounds,
} from "@/utils/RecordHelper";

const PING_HISTORY_REFRESH_INTERVAL_MS = 10_000;

export const usePingChart = (
  node: NodeData | null,
  hours: number,
  range?: HistoryQueryRange | null
) => {
  const { getPingHistory } = useNodeData();
  const requestIdRef = useRef(0);
  const hasHistoryRef = useRef(false);
  const [pingHistory, setPingHistory] = useState<PingHistoryResponse | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyBounds, setHistoryBounds] = useState<HistoryBounds | null>(null);
  const [isDataEmpty, setIsDataEmpty] = useState(true);
  const rangeStart = range?.start;
  const rangeEnd = range?.end;

  const fetchHistory = useCallback(async () => {
    if (!node?.uuid) return;

    const requestId = ++requestIdRef.current;
    const requestedRange =
      rangeStart && rangeEnd ? { start: rangeStart, end: rangeEnd } : null;
    const requestTime = Date.now();
    const hasPreviousHistory = hasHistoryRef.current;

    if (!hasPreviousHistory) {
      setLoading(true);
      setPingHistory(null);
    }
    setError(null);
    setHistoryBounds(
      resolveHistoryBounds(hours, requestedRange, null, requestTime)
    );

    try {
      const data = await getPingHistory(node.uuid, hours, requestedRange);
      if (requestId !== requestIdRef.current) return;

      setPingHistory(data);
      setHistoryBounds(
        resolveHistoryBounds(hours, requestedRange, data, requestTime)
      );
      setIsDataEmpty(
        !data?.records.some(
          (record) =>
            typeof record.value === "number" &&
            Number.isFinite(record.value) &&
            record.value >= 0
        )
      );
      hasHistoryRef.current = data !== null;
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setError(err.message || "Failed to fetch history data");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [getPingHistory, node?.uuid, hours, rangeStart, rangeEnd]);

  useEffect(() => {
    hasHistoryRef.current = false;
    setPingHistory(null);
    setHistoryBounds(null);
    setIsDataEmpty(true);

    if (!node?.uuid) {
      setLoading(false);
      return;
    }

    void fetchHistory();
    const refreshTimer = window.setInterval(() => {
      void fetchHistory();
    }, PING_HISTORY_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(refreshTimer);
      requestIdRef.current += 1;
    };
  }, [fetchHistory, node?.uuid]);

  return {
    loading,
    error,
    pingHistory,
    historyBounds,
    isDataEmpty,
  };
};
