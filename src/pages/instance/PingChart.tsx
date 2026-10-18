import { memo, useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useMobile";
import { Eye, EyeOff, ArrowRightToLine, RefreshCw } from "lucide-react";
import {
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Brush,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@radix-ui/react-label";
import type { NodeData, PingTaskFull } from "@/types/node";
import { apiService, type HistoryQueryRange } from "@/services/api";
import Loading from "@/components/loading";
import { usePingChart } from "@/hooks/usePingChart";
import {
  cutPeakValues,
  calculateTaskStats,
  interpolateNullsLinear,
  insertSeriesGapRows,
} from "@/utils/RecordHelper";
import { useAppConfig } from "@/config";
import { ScrollableTooltip } from "@/components/ui/tooltip";
import { useTooltipScrollLock } from "@/hooks/useTooltipScrollLock";
import Tips from "@/components/ui/tips";
import { generateColor, lableFormatter } from "@/utils/chartHelper";
import { useLocale } from "@/config/hooks";
import {
  lttbDownsamplePreservingGaps,
  calculateAutoMaxPoints,
} from "@/utils/downsample";

interface PingChartProps {
  node: NodeData;
  hours: number;
  range?: HistoryQueryRange | null;
}

const getPacketLossPercent = (record: {
  value: number | null;
  loss_ratio?: number | null;
}) => {
  if (typeof record.loss_ratio === "number" && Number.isFinite(record.loss_ratio)) {
    const ratio = record.loss_ratio <= 1 ? record.loss_ratio * 100 : record.loss_ratio;
    return Math.max(0, Math.min(100, ratio));
  }
  if (typeof record.value === "number" && Number.isFinite(record.value)) {
    return record.value < 0 ? 100 : 0;
  }
  return null;
};

const PingChart = memo(({ node, hours, range }: PingChartProps) => {
  const { enableCutPeak, enableConnectBreaks, pingChartMaxPoints, monitorNodeSortMode, monitorNodeCustomOrder } = useAppConfig();
  const { loading, error, pingHistory, historyBounds, isDataEmpty } =
    usePingChart(node, hours, range);
  const historyStart = historyBounds?.start;
  const historyEnd = historyBounds?.end;
  const [visiblePingTasks, setVisiblePingTasks] = useState<number[]>([]);
  const [timeRange, setTimeRange] = useState<[number, number] | null>(null);
  const [brushIndices, setBrushIndices] = useState<{
    startIndex?: number;
    endIndex?: number;
  }>({});
  const [cutPeak, setCutPeak] = useState(enableCutPeak);
  const [connectBreaks, setConnectBreaks] = useState(enableConnectBreaks);
  const [isResetting, setIsResetting] = useState(false);
  const isMobile = useIsMobile();
  const { t } = useLocale();
  const { chartContentRef, handleChartMouseMove, tooltipProps } = useTooltipScrollLock();

  // 管理员 Ping 任务数据（用于按 target/type/weight 排序）
  const [pingTasksFull, setPingTasksFull] = useState<PingTaskFull[]>([]);
  useEffect(() => {
    const needsAdminData = ["target_asc", "target_desc", "type_asc", "type_desc", "weight_asc", "weight_desc"].includes(monitorNodeSortMode);
    if (needsAdminData) {
      apiService.getPingTasks().then((tasks) => setPingTasksFull(tasks));
    }
  }, [monitorNodeSortMode]);

  useEffect(() => {
    if (pingHistory?.tasks) {
      const taskIds = pingHistory.tasks.map((t) => t.id);
      setVisiblePingTasks((prevVisibleTasks) => {
        const newVisibleTasks = taskIds.filter(
          (id) => prevVisibleTasks.length === 0 || prevVisibleTasks.includes(id)
        );
        return newVisibleTasks.length > 0 ? newVisibleTasks : taskIds;
      });
    }
  }, [pingHistory?.tasks]);

  useEffect(() => {
    setTimeRange(null);
    setBrushIndices({});
    setIsResetting(false);
  }, [hours, node.uuid, range?.start, range?.end]);

  useEffect(() => {
    if (isResetting) {
      setTimeRange(null);
      setBrushIndices({});
      setIsResetting(false);
    }
  }, [isResetting]);

  const chartMargin = { top: 8, right: 16, bottom: 8, left: 16 };

  const midData = useMemo(() => {
    const data = pingHistory?.records || [];
    const tasks = pingHistory?.tasks || [];
    if (!data.length && historyStart === undefined) return [];

    const taskIntervals = tasks
      .map((t) => t.data_interval || t.interval)
      .filter((v): v is number => typeof v === "number" && v > 0);
    const fallbackIntervalSec = taskIntervals.length
      ? Math.min(...taskIntervals)
      : 60;

    const toleranceMs = Math.min(
      6000,
      Math.max(800, Math.floor(fallbackIntervalSec * 1000 * 0.25))
    );

    // 使用分桶匹配替代线性扫描 O(n*m) -> O(n)
    const bucketSize = toleranceMs * 2;
    const grouped: Record<number, any> = {};
    const bucketToAnchor = new Map<number, number>();

    for (const rec of data) {
      const ts = new Date(rec.time).getTime();
      const bucket = Math.floor(ts / bucketSize);

      let anchor: number | null = null;
      for (const b of [bucket - 1, bucket, bucket + 1]) {
        const candidate = bucketToAnchor.get(b);
        if (candidate !== undefined && Math.abs(candidate - ts) <= toleranceMs) {
          anchor = candidate;
          break;
        }
      }

      const use = anchor ?? ts;
      if (!grouped[use]) {
        grouped[use] = { time: new Date(use).toISOString(), __ts: use };
        if (anchor === null) {
          bucketToAnchor.set(bucket, use);
        }
      }
      const taskKey = String(rec.task_id);
      grouped[use][taskKey] =
        typeof rec.value === "number" &&
        Number.isFinite(rec.value) &&
        rec.value >= 0
          ? rec.value
          : null;
      const packetLoss = getPacketLossPercent(rec);
      if (packetLoss !== null) {
        grouped[use][`${taskKey}__loss`] = packetLoss;
      }
    }

    if (historyStart !== undefined && historyEnd !== undefined) {
      for (const time of [historyStart, historyEnd]) {
        if (!grouped[time]) {
          grouped[time] = {
            time: new Date(time).toISOString(),
            __ts: time,
            __rangeAnchor: true,
          };
        }
      }
    }

    const merged = Object.values(grouped).sort(
      (a: any, b: any) => a.__ts - b.__ts
    );

    if (!merged.length) return [];

    const lastTs = (merged as any[])[(merged as any[]).length - 1].__ts;
    const fromTs = historyStart ?? lastTs - hours * 3600_000;
    const toTs = historyEnd ?? Infinity;
    let startIdx = 0;
    for (let i = 0; i < (merged as any[]).length; i++) {
      if ((merged as any[])[i].__ts >= fromTs) {
        startIdx = Math.max(0, i - 1);
        break;
      }
    }
    return (merged as any[]).slice(startIdx).filter((row) => row.__ts <= toTs);
  }, [pingHistory, hours, historyStart, historyEnd]);

  const chartData = useMemo(() => {
    let full = midData;
    const tasks = pingHistory?.tasks || [];
    if (!full.length) return [];

    const activeTasks = tasks.filter((task) => visiblePingTasks.includes(task.id));
    if (!activeTasks.length) return [];

    const keys = activeTasks.map((task) => String(task.id));
    const singleTaskKey = keys.length === 1 ? keys[0] : null;
    const packetLossKey = singleTaskKey ? `${singleTaskKey}__loss` : null;
    const intervalByKey = new Map(
      activeTasks.map((task) => [
        String(task.id),
        Math.max(
          30,
          Number(task.data_interval) || Number(task.interval) || 60
        ) * 1000,
      ])
    );

    full = insertSeriesGapRows(full, intervalByKey, 1.5);

    const autoMax = calculateAutoMaxPoints(full.length, keys.length);
    const effectiveMax = pingChartMaxPoints > 0 ? pingChartMaxPoints : autoMax;
    const preProcessMax =
      effectiveMax > 0 ? Math.min(full.length, effectiveMax * 4) : 0;

    if (preProcessMax > 0 && full.length > preProcessMax) {
      const withTs = full.map((d: any) => ({
        ...d,
        time: d.__ts ?? new Date(d.time).getTime(),
      }));
      full = lttbDownsamplePreservingGaps(withTs, preProcessMax, keys);
    }

    if (cutPeak) {
      full = cutPeakValues(full, keys);
    }

    const keyCount = keys.length;
    const preservedNulls = new Uint8Array(full.length * keyCount);
    for (let i = 0; i < full.length; i++) {
      for (let ki = 0; ki < keyCount; ki++) {
        if (full[i][keys[ki]] === null) {
          preservedNulls[i * keyCount + ki] = 1;
        }
      }
    }

    full = interpolateNullsLinear(full, keys, {
      maxGapMultiplier: 6,
      minCapMs: 2 * 60_000,
      maxCapMs: 30 * 60_000,
    });

    for (let i = 0; i < full.length; i++) {
      for (let ki = 0; ki < keyCount; ki++) {
        if (preservedNulls[i * keyCount + ki] === 1) {
          full[i][keys[ki]] = null;
        }
      }
    }

    const toChartPoint = (point: any) => ({
      ...point,
      time: point.__ts ?? new Date(point.time).getTime(),
      ...(packetLossKey
        ? { packet_loss: point[packetLossKey] ?? null }
        : {}),
    });

    if (effectiveMax > 0 && full.length > effectiveMax) {
      const withTs = full.map((d: any) => ({
        ...d,
        time: d.__ts ?? new Date(d.time).getTime(),
      }));
      return lttbDownsamplePreservingGaps(withTs, effectiveMax, keys).map(
        toChartPoint
      );
    }

    return full.map(toChartPoint);
  }, [
    midData,
    cutPeak,
    pingHistory?.tasks,
    pingChartMaxPoints,
    visiblePingTasks,
  ]);

  const handleTaskVisibilityToggle = (taskId: number) => {
    setVisiblePingTasks((prev) =>
      prev.includes(taskId)
        ? prev.filter((id) => id !== taskId)
        : [...prev, taskId]
    );
  };

  const handleToggleAll = () => {
    if (!pingHistory?.tasks) return;
    if (visiblePingTasks.length === pingHistory.tasks.length) {
      setVisiblePingTasks([]);
    } else {
      setVisiblePingTasks(pingHistory.tasks.map((t) => t.id));
    }
  };

  const sortedTasks = useMemo(() => {
    if (!pingHistory?.tasks) return [];
    const tasks = [...pingHistory.tasks];

    // 构建 admin API 数据查找表（用于 target/type 排序）
    const adminTaskMap = new Map<number, PingTaskFull>();
    for (const task of pingTasksFull) {
      adminTaskMap.set(task.id, task);
    }

    const mode = monitorNodeSortMode;

    if (mode === "custom") {
      const customLines = monitorNodeCustomOrder
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const orderMap = new Map<string, number>();
      customLines.forEach((name, idx) => orderMap.set(name, idx));
      tasks.sort((a, b) => {
        const aIdx = orderMap.get(a.name);
        const bIdx = orderMap.get(b.name);
        if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
        if (aIdx !== undefined) return -1;
        if (bIdx !== undefined) return 1;
        return a.id - b.id;
      });
    } else if (mode === "name_asc" || mode === "name_desc") {
      const dir = mode === "name_asc" ? 1 : -1;
      tasks.sort((a, b) => dir * a.name.localeCompare(b.name));
    } else if (mode === "id_asc" || mode === "id_desc") {
      const dir = mode === "id_asc" ? 1 : -1;
      tasks.sort((a, b) => dir * (a.id - b.id));
    } else if (mode === "weight_asc" || mode === "weight_desc") {
      const dir = mode === "weight_asc" ? 1 : -1;
      if (adminTaskMap.size > 0) {
        tasks.sort((a, b) => {
          const aw = adminTaskMap.get(a.id)?.weight ?? 0;
          const bw = adminTaskMap.get(b.id)?.weight ?? 0;
          if (aw === bw) return dir * (a.id - b.id);
          return dir * (aw - bw);
        });
      } else {
        tasks.sort((a, b) => dir * (a.id - b.id));
      }
    } else if (mode === "target_asc" || mode === "target_desc") {
      const dir = mode === "target_asc" ? 1 : -1;
      if (adminTaskMap.size > 0) {
        tasks.sort((a, b) => {
          const at = adminTaskMap.get(a.id)?.target ?? "";
          const bt = adminTaskMap.get(b.id)?.target ?? "";
          return dir * at.localeCompare(bt);
        });
      } else {
        tasks.sort((a, b) => dir * (a.id - b.id));
      }
    } else if (mode === "type_asc" || mode === "type_desc") {
      const dir = mode === "type_asc" ? 1 : -1;
      if (adminTaskMap.size > 0) {
        tasks.sort((a, b) => {
          const at = adminTaskMap.get(a.id)?.type ?? "";
          const bt = adminTaskMap.get(b.id)?.type ?? "";
          return dir * at.localeCompare(bt);
        });
      } else {
        tasks.sort((a, b) => dir * (a.id - b.id));
      }
    } else {
      tasks.sort((a, b) => a.id - b.id);
    }

    return tasks;
  }, [pingHistory?.tasks, monitorNodeSortMode, monitorNodeCustomOrder, pingTasksFull]);

  const breakPoints = useMemo(() => {
    if (!connectBreaks || !chartData || chartData.length < 2) {
      return [];
    }
    const MAX_BREAKPOINTS = 200;
    const points: { x: number; color: string }[] = [];
    for (const task of sortedTasks) {
      if (!visiblePingTasks.includes(task.id)) {
        continue;
      }
      if (points.length >= MAX_BREAKPOINTS) break;
      const taskKey = String(task.id);
      for (let i = 1; i < chartData.length; i++) {
        if (points.length >= MAX_BREAKPOINTS) break;
        const prevPoint = chartData[i - 1];
        const currentPoint = chartData[i];

        const isBreak =
          !currentPoint.__rangeAnchor &&
          (currentPoint[taskKey] === null ||
            currentPoint[taskKey] === undefined) &&
          prevPoint[taskKey] !== null &&
          prevPoint[taskKey] !== undefined;

        if (isBreak) {
          points.push({
            x: currentPoint.time,
            color: generateColor(task.name, sortedTasks),
          });
        }
      }
    }
    return points;
  }, [chartData, sortedTasks, visiblePingTasks, connectBreaks]);

  const taskStats = useMemo(() => {
    if (!pingHistory?.records || !sortedTasks.length) return [];

    return sortedTasks.map((task) => {
      const { loss, latestValue, latestTime, minValue, maxValue } = calculateTaskStats(
        pingHistory.records,
        task.id,
        timeRange,
        task.loss
      );
      return {
        ...task,
        value: latestValue,
        time: latestTime,
        minValue,
        maxValue,
        loss: loss,
        color: generateColor(task.name, sortedTasks),
      };
    });
  }, [pingHistory?.records, sortedTasks, timeRange]);

  // 仅可见的任务（条件渲染替代 hide 属性）
  const visibleSortedTasks = useMemo(
    () => sortedTasks.filter((t) => visiblePingTasks.includes(t.id)),
    [sortedTasks, visiblePingTasks]
  );
  const selectedTask =
    visibleSortedTasks.length === 1 ? visibleSortedTasks[0] : null;


  return (
    <div className="relative space-y-4 h-full flex flex-col min-h-114">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center purcarte-blur rounded-lg z-10">
          <Loading text={t("chart.loadingData")} />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center purcarte-blur rounded-lg z-10">
          <p className="text-red-500">{error}</p>
        </div>
      )}

      {pingHistory?.tasks && pingHistory.tasks.length > 0 && (
        <Card className="relative">
          <div className="absolute top-2 right-2">
            <Tips>
              <span
                dangerouslySetInnerHTML={{
                  __html: t("chart.packetLossCalculationWarning"),
                }}></span>
            </Tips>
          </div>
          <CardContent className="p-2">
            <div className="flex flex-wrap gap-2 items-center justify-center">
              {taskStats.map((task) => {
                const isVisible = visiblePingTasks.includes(task.id);

                return (
                  <div
                    key={task.id}
                    className={`h-auto px-3 py-1.5 flex flex-col leading-snug text-center cursor-pointer rounded-md transition-all outline-2 outline ${
                      isVisible ? "" : "outline-transparent"
                    }`}
                    onClick={() => handleTaskVisibilityToggle(task.id)}
                    style={{
                      outlineColor: isVisible ? task.color : undefined,
                      boxShadow: isVisible
                        ? `0 0 8px ${task.color}`
                        : undefined,
                    }}>
                    <div className="font-semibold text-xs sm:text-sm whitespace-nowrap">
                      {task.name}
                    </div>
                    {task.value !== null ? (
                      <>
                        <div className="text-sm sm:text-base font-semibold leading-none">
                          {task.value.toFixed(2)} ms
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-x-2 text-xs font-normal">
                          {task.minValue !== null && (
                            <span className="text-green-600">↓{task.minValue.toFixed(0)}</span>
                          )}
                          {task.maxValue !== null && (
                            <span className="text-red-600">↑{task.maxValue.toFixed(0)}</span>
                          )}
                          <span className="text-secondary-foreground">
                            {task.loss.toFixed(2)}%
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs font-normal">
                        {t("node.notAvailable")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="flex-grow flex flex-col">
        <CardHeader>
          <div className="flex justify-between items-center flex-wrap">
            <div className="flex gap-4 flex-wrap">
              <div className="flex items-center space-x-2">
                <Switch
                  id="peak-shaving"
                  checked={cutPeak}
                  onCheckedChange={setCutPeak}
                />
                <Label htmlFor="peak-shaving">{t("chart.smooth")}</Label>
                <Tips>
                  <span
                    dangerouslySetInnerHTML={{
                      __html: t("chart.smoothTooltipContent"),
                    }}
                  />
                </Tips>
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="connect-breaks"
                  checked={connectBreaks}
                  onCheckedChange={setConnectBreaks}
                />
                <Label htmlFor="connect-breaks">
                  {t("chart.connectBreaks")}
                </Label>
                <Tips>
                  <span
                    dangerouslySetInnerHTML={{
                      __html: t("chart.connectBreaksTooltipContent"),
                    }}
                  />
                </Tips>
              </div>
            </div>
            <div className={`flex gap-2 ${isMobile ? "w-full mt-2" : ""}`}>
              <Button variant="default" onClick={handleToggleAll} size="sm">
                {pingHistory?.tasks &&
                visiblePingTasks.length === pingHistory.tasks.length ? (
                  <>
                    <EyeOff size={16} />
                    {t("chart.hideAll")}
                  </>
                ) : (
                  <>
                    <Eye size={16} />
                    {t("chart.showAll")}
                  </>
                )}
              </Button>
              <Button
                variant="default"
                onClick={() => {
                  if (timeRange) {
                    if (chartData.length > 1) {
                      const endIndex = chartData.length - 1;
                      const startIndex = 0;
                      setTimeRange([
                        chartData[startIndex].time,
                        chartData[endIndex].time,
                      ]);
                      setBrushIndices({ startIndex, endIndex });
                      setIsResetting(true);
                    }
                  } else if (chartData.length > 1) {
                    const endIndex = chartData.length - 1;
                    const startIndex = Math.floor(endIndex * 0.75);
                    setTimeRange([
                      chartData[startIndex].time,
                      chartData[endIndex].time,
                    ]);
                    setBrushIndices({ startIndex, endIndex });
                  }
                }}
                size="sm">
                {timeRange ? (
                  <RefreshCw size={16} />
                ) : (
                  <ArrowRightToLine size={16} />
                )}
                {timeRange ? t("chart.resetRange") : t("chart.oneQuarter")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="relative pt-0 flex-grow flex flex-col" ref={chartContentRef}>
          {chartData.length > 0 ? (
            <ResponsiveContainer
              width="100%"
              height="100%"
              className={"min-h-90"}>
              <ComposedChart data={chartData} margin={chartMargin} onMouseMove={handleChartMouseMove}>
                <CartesianGrid
                  strokeDasharray="2 4"
                  stroke="var(--theme-line-muted-color)"
                  vertical={false}
                />
                <XAxis
                  type="number"
                  dataKey="time"
                  domain={
                    timeRange ||
                    (historyStart !== undefined && historyEnd !== undefined
                      ? [historyStart, historyEnd]
                      : ["dataMin", "dataMax"])
                  }
                  tickFormatter={(time) => {
                    const date = new Date(time);
                    if (hours === 0) {
                      return date.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      });
                    }
                    return date.toLocaleString([], {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                  }}
                  tick={{ fill: "var(--theme-text-muted-color)" }}
                  axisLine={{
                    stroke: "var(--theme-line-muted-color)",
                  }}
                  scale="time"
                />
                <YAxis
                  yAxisId="delay"
                  width={42}
                  tick={{ fill: "var(--theme-text-muted-color)" }}
                  tickFormatter={(value) => `${value}ms`}
                  axisLine={{
                    stroke: "var(--theme-line-muted-color)",
                  }}
                />
                {selectedTask && (
                  <YAxis
                    yAxisId="packet-loss"
                    orientation="right"
                    width={42}
                    domain={[0, 100]}
                    tick={{ fill: "var(--theme-text-muted-color)" }}
                    tickFormatter={(value) => `${value}%`}
                    axisLine={{
                      stroke: "var(--theme-line-muted-color)",
                    }}
                  />
                )}
                <Tooltip
                  cursor={false}
                  wrapperStyle={{ zIndex: 100, pointerEvents: "none" }}
                  {...tooltipProps}
                  content={
                    <ScrollableTooltip
                      labelFormatter={(value: any) => lableFormatter(value, hours)}
                      chartConfig={{
                        series: [
                          ...(selectedTask
                            ? [
                                {
                                  dataKey: "packet_loss",
                                  tooltipLabel: t("chart.lossRate"),
                                  tooltipFormatter: (value: number) =>
                                    `${Number(value).toFixed(2)}%`,
                                },
                              ]
                            : []),
                          ...visibleSortedTasks.map((task) => ({
                            dataKey: String(task.id),
                            tooltipLabel: task.name,
                            tooltipFormatter: (value: number) =>
                              `${Number(value).toFixed(2)} ms`,
                          })),
                        ],
                      }}
                    />
                  }
                />
                {connectBreaks &&
                  breakPoints.map((point, index) => (
                    <ReferenceLine
                      key={`break-${index}`}
                      x={point.x}
                      stroke={point.color}
                      strokeWidth={1.5}
                      strokeOpacity={0.6}
                    />
                  ))}
                {selectedTask && (
                  <Area
                    type="linear"
                    dataKey="packet_loss"
                    name={t("chart.lossRate")}
                    yAxisId="packet-loss"
                    stroke="#f59e0b"
                    fill="#f59e0b"
                    fillOpacity={0.24}
                    strokeWidth={1}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                )}
                {visibleSortedTasks.map((task) => (
                  <Line
                    key={task.id}
                    type="linear"
                    dataKey={String(task.id)}
                    name={task.name}
                    yAxisId="delay"
                    stroke={generateColor(task.name, sortedTasks)}
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls={connectBreaks}
                    isAnimationActive={visibleSortedTasks.length <= 10}
                  />
                ))}
                <Brush
                  {...brushIndices}
                  dataKey="time"
                  height={30}
                  stroke="var(--theme-text-muted-color)"
                  fill="var(--accent-a4)"
                  tickFormatter={(time) => {
                    const date = new Date(time);
                    if (hours === 0) {
                      return date.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      });
                    }
                    return date.toLocaleDateString([], {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                  }}
                  onChange={(e: any) => {
                    if (
                      e.startIndex !== undefined &&
                      e.endIndex !== undefined &&
                      chartData[e.startIndex] &&
                      chartData[e.endIndex]
                    ) {
                      setTimeRange([
                        chartData[e.startIndex].time,
                        chartData[e.endIndex].time,
                      ]);
                      setBrushIndices({
                        startIndex: e.startIndex,
                        endIndex: e.endIndex,
                      });
                    } else {
                      setTimeRange(null);
                      setBrushIndices({});
                    }
                  }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="min-h-90 flex items-center justify-center">
              <p>{t("chart.noData")}</p>
            </div>
          )}
          {!loading && isDataEmpty && chartData.length > 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p>{t("chart.noData")}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
});

export default PingChart;
