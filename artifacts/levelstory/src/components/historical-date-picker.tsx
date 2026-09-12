import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canonicalToDate, dateToCanonical, formatDateForDisplay, parseDateText } from "@/lib/historical-date";

type DatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  minDate?: string | null;
  maxDate?: string | null;
  eligibleDates?: readonly string[];
  disabledDateReasons?: ReadonlyMap<string, string>;
  label?: string;
};

const FALLBACK_MIN_DATE = "2021-01-01";
const FALLBACK_MAX_DATE = "2026-12-31";

function addDays(value: string, amount: number): string | null {
  const date = canonicalToDate(value);
  if (!date) return null;
  date.setDate(date.getDate() + amount);
  return dateToCanonical(date);
}

function todayInNewYork(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function DatePickerDayButton({
  day,
  modifiers,
  ...props
}: ComponentProps<typeof CalendarDayButton>) {
  const disabled = Boolean(modifiers.disabled);
  return (
    <CalendarDayButton
      day={day}
      modifiers={modifiers}
      {...props}
      title={disabled ? "This date is outside indexed coverage or is not eligible." : undefined}
    />
  );
}

export function HistoricalDatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  eligibleDates,
  disabledDateReasons,
  label = "Review-period end date · New York",
}: DatePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const coverageMin = minDate ?? null;
  const coverageMax = maxDate ?? null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(formatDateForDisplay(value));
  const [error, setError] = useState<string | null>(null);
  const [displayMonth, setDisplayMonth] = useState(
    canonicalToDate(value) ?? canonicalToDate(coverageMax) ?? new Date(),
  );
  const knownEligibleDates = useMemo(
    () => eligibleDates === undefined ? undefined : [...new Set(eligibleDates)].sort(),
    [eligibleDates],
  );
  const effectiveMin = coverageMin ?? FALLBACK_MIN_DATE;
  const effectiveMax = coverageMax ?? FALLBACK_MAX_DATE;
  const minMonth = canonicalToDate(effectiveMin) ?? new Date(2021, 0, 1);
  const maxMonth = canonicalToDate(effectiveMax) ?? new Date(2026, 11, 31);

  useEffect(() => {
    setDraft(formatDateForDisplay(value));
    setError(null);
  }, [value]);

  const reasonForDate = (dateValue: string): string | null => {
    if (coverageMin && dateValue < coverageMin) return "Before the indexed historical coverage.";
    if (coverageMax && dateValue > coverageMax) return "After the indexed historical coverage.";
    const explicitReason = disabledDateReasons?.get(dateValue);
    if (explicitReason) return explicitReason;
    if (knownEligibleDates && !knownEligibleDates.includes(dateValue)) return "This date is not an eligible indexed trading date.";
    return null;
  };

  const commit = (nextValue: string, close = true): boolean => {
    const parsed = parseDateText(nextValue);
    if (!parsed) {
      setError("Enter a date as MM/DD/YYYY or YYYY-MM-DD.");
      return false;
    }
    const reason = reasonForDate(parsed);
    if (reason) {
      setError(reason);
      return false;
    }
    onChange(parsed);
    setDraft(formatDateForDisplay(parsed));
    setError(null);
    if (close) {
      setOpen(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    return true;
  };

  const chooseDate = (date: Date | undefined) => {
    if (!date) return;
    const nextValue = dateToCanonical(date);
    if (!reasonForDate(nextValue)) commit(nextValue);
  };

  const moveToRelativeDate = (direction: -1 | 1) => {
    const current = parseDateText(value) ?? effectiveMax;
    if (knownEligibleDates) {
      const next = knownEligibleDates.find((candidate) => direction < 0 ? candidate < current : candidate > current);
      if (next) commit(next);
      return;
    }
    let candidate = current;
    for (let attempts = 0; attempts < 370; attempts += 1) {
      candidate = addDays(candidate, direction) ?? candidate;
      if (!reasonForDate(candidate)) {
        commit(candidate);
        return;
      }
      if (candidate < effectiveMin || candidate > effectiveMax) return;
    }
  };

  const latestIndexedDate = coverageMax;
  const today = todayInNewYork();
  const canChooseToday = Boolean(coverageMin && coverageMax)
    && today >= effectiveMin
    && today <= effectiveMax
    && !reasonForDate(today);
  const selectedDate = canonicalToDate(value);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            required
            aria-label={label}
            aria-describedby={`${label.replaceAll(" ", "-")}-help`}
            aria-invalid={Boolean(error)}
            className="field mono w-full pr-10"
            value={draft}
            onFocus={() => {
              setDisplayMonth(selectedDate ?? canonicalToDate(effectiveMax) ?? new Date());
              setOpen(true);
            }}
            onClick={() => setOpen(true)}
            onChange={(event) => {
              const nextDraft = event.target.value;
              setDraft(nextDraft);
              const parsed = parseDateText(nextDraft);
              if (parsed && !reasonForDate(parsed)) {
                onChange(parsed);
                setDraft(formatDateForDisplay(parsed));
                setError(null);
              } else if (error) {
                setError(null);
              }
            }}
            onBlur={() => {
              if (draft.trim()) {
                const parsed = parseDateText(draft);
                if (parsed) commit(parsed, false);
                else setError("Enter a date as MM/DD/YYYY or YYYY-MM-DD.");
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(draft);
              }
              if (event.key === "Escape") {
                setDraft(formatDateForDisplay(value));
                setError(null);
                setOpen(false);
              }
            }}
          />
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Open ${label} picker`}
                className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                onMouseDown={(event) => event.preventDefault()}
              >
                <CalendarDays size={15} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="bottom"
              className="w-auto max-w-[calc(100vw-1rem)] p-2"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <Calendar
                mode="single"
                selected={selectedDate ?? undefined}
                month={displayMonth}
                onMonthChange={setDisplayMonth}
                onSelect={chooseDate}
                fromMonth={minMonth}
                toMonth={maxMonth}
                captionLayout="dropdown"
                disabled={(date) => Boolean(reasonForDate(dateToCanonical(date)))}
                components={{ DayButton: DatePickerDayButton }}
                aria-label={`${label} calendar`}
              />
              <p className="px-3 pb-1 text-[10px] leading-4 text-muted-foreground" id={`${label.replaceAll(" ", "-")}-help`}>
                Disabled dates are outside indexed coverage or are not eligible trading dates.
              </p>
              <div className="flex flex-wrap gap-1 border-t border-border px-3 pt-2">
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => moveToRelativeDate(-1)}>
                  <ChevronLeft size={12} aria-hidden="true" /> Previous eligible date
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => moveToRelativeDate(1)}>
                  Next eligible date <ChevronRight size={12} aria-hidden="true" />
                </Button>
                {latestIndexedDate && <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => commit(latestIndexedDate)} disabled={Boolean(reasonForDate(latestIndexedDate))}>
                  Latest indexed date
                </Button>}
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => commit(today)} disabled={!canChooseToday}>
                  Today
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {error && <p className="text-[10px] text-negative" role="alert">{error}</p>}
      {!knownEligibleDates && <p className="text-[10px] text-muted-foreground">Previous/next actions use calendar days until eligible-date metadata is available.</p>}
    </div>
  );
}