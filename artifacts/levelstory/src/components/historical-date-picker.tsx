import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canonicalToDate, dateToCanonical, formatDateForDisplay, parseDateText } from "@/lib/historical-date";
import { historicalDateReason, latestEligibleDate, relativeEligibleDate, restoreLastEligibleDate, sortedEligibleDates } from "@/lib/historical-date-picker";

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

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
}

function monthLabel(date: Date): string {
  return date.toLocaleString("en-US", { month: "long", year: "numeric" });
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
  dateReason,
  ...props
}: ComponentProps<typeof CalendarDayButton> & { dateReason?: string | null }) {
  const disabled = Boolean(modifiers.disabled);
  const eligible = Boolean(modifiers.eligible);
  const ineligible = Boolean(modifiers.ineligible);
  return (
    <CalendarDayButton
      day={day}
      modifiers={modifiers}
      {...props}
      aria-label={`${day.date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}${eligible ? ", eligible trading date" : ineligible ? `, unavailable trading date, ${dateReason ?? "not an eligible indexed trading date"}` : disabled ? `, ${dateReason ?? "outside indexed coverage"}` : ""}`}
      title={disabled ? (dateReason ?? "This date is not an eligible indexed trading date.") : undefined}
      className={ineligible ? "text-muted-foreground line-through opacity-60" : eligible ? "font-semibold" : undefined}
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
  const [lastValidValue, setLastValidValue] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [displayMonth, setDisplayMonth] = useState(
    canonicalToDate(value) ?? canonicalToDate(coverageMax) ?? new Date(),
  );
  const knownEligibleDates = useMemo(() => sortedEligibleDates(eligibleDates), [eligibleDates]);
  const effectiveMin = coverageMin ?? FALLBACK_MIN_DATE;
  const effectiveMax = coverageMax ?? FALLBACK_MAX_DATE;
  const minMonth = canonicalToDate(effectiveMin) ?? new Date(2021, 0, 1);
  const maxMonth = canonicalToDate(effectiveMax) ?? new Date(2026, 11, 31);
  const monthOptions = useMemo(() => {
    const options: Date[] = [];
    for (let cursor = new Date(minMonth.getFullYear(), minMonth.getMonth(), 1); cursor <= maxMonth; cursor = addMonths(cursor, 1)) {
      options.push(cursor);
    }
    return options;
  }, [maxMonth, minMonth]);
  const yearOptions = useMemo(
    () => [...new Set(monthOptions.map((date) => date.getFullYear()))],
    [monthOptions],
  );

  const reasonForDate = (dateValue: string): string | null => {
    return historicalDateReason(dateValue, knownEligibleDates, coverageMin, coverageMax, disabledDateReasons);
  };

  const nearestEligibleHint = (dateValue: string): string => {
    if (!knownEligibleDates || dateValue < effectiveMin || dateValue > effectiveMax) return "";
    const previous = relativeEligibleDate(dateValue, -1, knownEligibleDates);
    const next = relativeEligibleDate(dateValue, 1, knownEligibleDates);
    const choices = [
      previous ? `previous eligible date ${formatDateForDisplay(previous)}` : null,
      next ? `next eligible date ${formatDateForDisplay(next)}` : null,
    ].filter(Boolean);
    return choices.length ? ` Choose the ${choices.join(" or ")}.` : " Choose Latest indexed date.";
  };

  const commit = (nextValue: string, close = true): boolean => {
    const parsed = parseDateText(nextValue);
    if (!parsed) {
      setError("Enter a date as MM/DD/YYYY or YYYY-MM-DD.");
      return false;
    }
    const reason = reasonForDate(parsed);
    if (reason) {
      setError(`${reason}${nearestEligibleHint(parsed)}`);
      return false;
    }
    onChange(parsed);
    setLastValidValue(parsed);
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
    commit(dateToCanonical(date));
  };

  const moveToRelativeDate = (direction: -1 | 1) => {
    if (!knownEligibleDates) {
      setError("Eligible trading-date metadata is still loading.");
      return;
    }
    const current = parseDateText(draft) ?? parseDateText(value) ?? latestEligibleDate(knownEligibleDates) ?? effectiveMax;
    const next = relativeEligibleDate(current, direction, knownEligibleDates);
    if (next) commit(next);
  };

  const latestIndexedDate = latestEligibleDate(knownEligibleDates);
  const today = todayInNewYork();
  const canChooseToday = Boolean(knownEligibleDates?.includes(today));
  const selectedDate = canonicalToDate(value);
  const selectedDateIsEligible = selectedDate
    ? !reasonForDate(dateToCanonical(selectedDate))
    : false;
  const navigationDate = parseDateText(draft) ?? value;
  const previousEligibleDate = knownEligibleDates
    ? relativeEligibleDate(navigationDate, -1, knownEligibleDates)
    : null;
  const nextEligibleDate = knownEligibleDates
    ? relativeEligibleDate(navigationDate, 1, knownEligibleDates)
    : null;
  const currentMonthKey = monthOptions.some((date) => monthKey(date) === monthKey(displayMonth))
    ? monthKey(displayMonth)
    : monthKey(maxMonth);
  const currentMonth = monthOptions.find((date) => monthKey(date) === currentMonthKey) ?? maxMonth;

  useEffect(() => {
    setDraft(formatDateForDisplay(value));
    if (knownEligibleDates?.includes(value)) {
      setLastValidValue(value);
      setError(null);
    }
  }, [knownEligibleDates, value]);

  useEffect(() => {
    if (!knownEligibleDates || knownEligibleDates.includes(value)) return;
    const fallback = restoreLastEligibleDate(lastValidValue, knownEligibleDates);
    setDraft(formatDateForDisplay(fallback));
    setError(`${reasonForDate(value) ?? "The selected date is no longer eligible."}${fallback ? "" : " Choose Latest indexed date."}`);
  // The picker should react to metadata refreshes without changing focus or silently selecting a replacement.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownEligibleDates]);

  const closePopover = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={closePopover}>
          <PopoverAnchor asChild>
            <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            required
            aria-label={label}
            aria-describedby={`${label.replaceAll(" ", "-")}-help`}
            aria-invalid={Boolean(error)}
            className="field mono w-full pr-10"
            data-testid="historical-date-input"
            value={draft}
            onFocus={() => {
              setDisplayMonth(selectedDate ?? canonicalToDate(effectiveMax) ?? new Date());
              setOpen(true);
            }}
            onClick={() => setOpen(true)}
            onChange={(event) => {
              const nextDraft = event.target.value;
              setDraft(nextDraft);
              if (error) setError(null);
            }}
            onBlur={() => {
              if (!draft.trim()) {
                setDraft(formatDateForDisplay(lastValidValue));
                return;
              }
              const parsed = parseDateText(draft);
              if (!parsed || !commit(parsed, false)) {
                setDraft(formatDateForDisplay(
                  restoreLastEligibleDate(lastValidValue, knownEligibleDates),
                ));
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(draft);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(formatDateForDisplay(lastValidValue));
                setError(null);
                closePopover(false);
              }
            }}
          />
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
            </div>
          </PopoverAnchor>
          <PopoverContent
              align="start"
              side="bottom"
              sideOffset={6}
              className="w-[min(400px,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] p-2"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <div className="mb-1 grid grid-cols-2 gap-2 border-b border-border px-2 pb-2">
                <label className="space-y-1 text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">
                  <span>Month</span>
                  <select
                    aria-label="Select month"
                    className="field h-8 w-full py-1 pr-7 text-xs normal-case tracking-normal"
                    value={currentMonthKey}
                    onChange={(event) => {
                      const next = monthOptions.find((date) => monthKey(date) === event.target.value);
                      if (next) setDisplayMonth(next);
                    }}
                  >
                    {monthOptions.map((date) => <option key={monthKey(date)} value={monthKey(date)}>{date.toLocaleString("en-US", { month: "long" })}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">
                  <span>Year</span>
                  <select
                    aria-label="Select year"
                    className="field h-8 w-full py-1 pr-7 text-xs normal-case tracking-normal"
                    value={currentMonth.getFullYear()}
                    onChange={(event) => {
                      const nextYear = Number(event.target.value);
                      const next = monthOptions.find((date) => date.getFullYear() === nextYear && date.getMonth() === currentMonth.getMonth())
                        ?? monthOptions.find((date) => date.getFullYear() === nextYear);
                      if (next) setDisplayMonth(next);
                    }}
                  >
                    {yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
                  </select>
                </label>
              </div>
              <div className="relative">
                <div className="sr-only" aria-live="polite">Showing {monthLabel(currentMonth)}</div>
                <Calendar
                  mode="single"
                  selected={selectedDateIsEligible ? selectedDate ?? undefined : undefined}
                  month={currentMonth}
                  onMonthChange={setDisplayMonth}
                  onSelect={chooseDate}
                  fromMonth={minMonth}
                  toMonth={maxMonth}
                  captionLayout="label"
                  disabled={(date) => Boolean(reasonForDate(dateToCanonical(date)))}
                  modifiers={{
                    eligible: (date) => Boolean(knownEligibleDates?.includes(dateToCanonical(date))),
                    ineligible: (date) => Boolean(
                      knownEligibleDates
                      && dateToCanonical(date) >= effectiveMin
                      && dateToCanonical(date) <= effectiveMax
                      && !knownEligibleDates.includes(dateToCanonical(date)),
                    ),
                  }}
                  className="mx-auto"
                  components={{
                    DayButton: (props) => (
                      <DatePickerDayButton
                        {...props}
                        dateReason={reasonForDate(dateToCanonical(props.day.date))}
                      />
                    ),
                  }}
                  aria-label={`${label} calendar showing ${monthLabel(currentMonth)}`}
                />
              </div>
              <p className="px-3 pb-1 text-[10px] leading-4 text-muted-foreground" id={`${label.replaceAll(" ", "-")}-help`}>
                <span className="font-semibold text-foreground">Bold</span> dates are eligible. Struck-through dates are inside coverage but unavailable for the scheduled contract.
              </p>
              <div className="grid grid-cols-2 gap-1 border-t border-border px-3 pt-2">
                <Button type="button" variant="outline" size="sm" className="h-7 min-w-0 px-2 text-[10px]" aria-label="Previous eligible date" onClick={() => moveToRelativeDate(-1)} disabled={!previousEligibleDate}>
                  <ChevronLeft size={12} aria-hidden="true" /> Previous
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 min-w-0 px-2 text-[10px]" aria-label="Next eligible date" onClick={() => moveToRelativeDate(1)} disabled={!nextEligibleDate}>
                  Next <ChevronRight size={12} aria-hidden="true" />
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 min-w-0 px-2 text-[10px]" aria-label="Latest indexed date" onClick={() => latestIndexedDate && commit(latestIndexedDate)} disabled={!latestIndexedDate}>
                  Latest
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 min-w-0 px-2 text-[10px]" aria-label="Today" onClick={() => commit(today)} disabled={!canChooseToday}>
                  Today
                </Button>
              </div>
          </PopoverContent>
        </Popover>
        </div>
      {error && (
        <div className="space-y-1" role="alert">
          <p className="text-[10px] text-negative">{error}</p>
          {(previousEligibleDate || nextEligibleDate || latestIndexedDate) && (
            <div className="flex flex-wrap gap-1">
              {previousEligibleDate && <button type="button" className="text-[10px] font-semibold text-primary underline underline-offset-2" onClick={() => commit(previousEligibleDate)}>Use previous {formatDateForDisplay(previousEligibleDate)}</button>}
              {nextEligibleDate && <button type="button" className="text-[10px] font-semibold text-primary underline underline-offset-2" onClick={() => commit(nextEligibleDate)}>Use next {formatDateForDisplay(nextEligibleDate)}</button>}
              {latestIndexedDate && <button type="button" className="text-[10px] font-semibold text-primary underline underline-offset-2" onClick={() => commit(latestIndexedDate)}>Use latest indexed date</button>}
            </div>
          )}
        </div>
      )}
      {!knownEligibleDates && <p className="text-[10px] text-muted-foreground">Waiting for authoritative eligible-date metadata.</p>}
    </div>
  );
}