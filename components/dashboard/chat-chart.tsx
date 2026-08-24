"use client";

import {
  Bar,
  BarChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  NonZeroTooltipContent,
  chartPaletteColor,
  BRAND_AMBER,
} from "./dashboard-ui";
import { MAX_CHART_CONTACT_IDS, type ChartSpec } from "@/lib/ai-tools";

interface ChatChartProps {
  spec: ChartSpec;
  onDrill?: (title: string, contactIds: string[]) => void;
}

interface ChartDatum {
  label: string;
  value: number;
  contactIds: string[];
  fill: string;
}

export function ChatChart({ spec, onDrill }: ChatChartProps) {
  const data: ChartDatum[] = spec.series.map((s, i) => ({
    label: s.label,
    value: s.value,
    contactIds: s.contactIds ?? [],
    fill: chartPaletteColor(i),
  }));

  const config: ChartConfig = {
    value: { label: spec.valueLabel ?? "Total", color: BRAND_AMBER },
  };

  const clickable = data.some((d) => d.contactIds.length > 0);

  const drill = (datum?: { contactIds?: string[] }) => {
    const ids = datum?.contactIds ?? [];
    if (ids.length > 0) onDrill?.(spec.title, ids);
  };

  // Bar & line expose the clicked point via the chart-level onClick state.
  // Recharts' CategoricalChartState is not exported, hence the loose typing.
  const onChartClick = (state: { activePayload?: Array<{ payload?: ChartDatum }> }) => {
    drill(state?.activePayload?.[0]?.payload);
  };

  return (
    <div className="w-full max-w-[520px] rounded-xl border border-border/50 bg-card/40 p-3">
      {spec.title && (
        <p className="mb-2 px-1 text-xs font-semibold text-foreground/80">
          {spec.title}
        </p>
      )}
      <ChartContainer config={config} className="h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === "pie" ? (
            <PieChart>
              <ChartTooltip content={<NonZeroTooltipContent nameKey="label" />} />
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius={50}
                outerRadius={90}
                paddingAngle={1}
                onClick={(d: { payload?: ChartDatum }) => drill(d?.payload ?? (d as ChartDatum))}
                className={clickable ? "cursor-pointer" : undefined}
              >
                {data.map((d, i) => (
                  <Cell key={i} fill={d.fill} />
                ))}
              </Pie>
            </PieChart>
          ) : spec.type === "line" ? (
            <LineChart
              data={data}
              margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              onClick={onChartClick}
              className={clickable ? "cursor-pointer" : undefined}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <ChartTooltip content={<NonZeroTooltipContent />} />
              <Line
                type="monotone"
                dataKey="value"
                stroke={BRAND_AMBER}
                strokeWidth={2}
                dot={{ r: 3, fill: BRAND_AMBER }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          ) : (
            <BarChart
              data={data}
              margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              onClick={onChartClick}
              className={clickable ? "cursor-pointer" : undefined}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <ChartTooltip content={<NonZeroTooltipContent />} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.fill} />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </ChartContainer>
      {clickable && (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground/60">
          Haz clic en una barra o sección para ver los contactos (hasta{" "}
          {MAX_CHART_CONTACT_IDS} por grupo).
        </p>
      )}
    </div>
  );
}
