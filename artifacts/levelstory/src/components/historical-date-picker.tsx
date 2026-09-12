import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canonicalToDate, dateToCanonical, formatDateForDisplay, parseDateText } from "@/lib/historical-date";
import {
  CALENDAR_MONTHS,
  clampDisplayMonth,
  historicalDateReason,
  latestEligibleDate,
  monthSelection,
  resolveOpeningMonth,
  sortedEligibleDates,
  yearSelection,
} from "@/lib/historical-date-picker";

type DatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  minDate?: string | null;
  maxDate?: string | null;
  availableDates?: readonly string[];
  eligibleDates?: readonly string[];
  disabledDateReasons?: ReadonlyMap<string, string>;
  label?: string;
};

const FALLBACK_MIN_DATE = "2021-01-01";
const FALLBACK_MAX_DATE = "2026-12-31";

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
  const available = Boolean(modifiers.available);
  return (
    <CalendarDayButton
      day={day}
      modifiers={modifiers}
      {...props}
      aria-label={`${day.date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}${available ? ", stored historical data" : disabled ? `, ${dateReason ?? "outside configured coverage"}` : ""}`}
      title={disabled ? (dateReason ?? "Outside configured historical coverage.") : undefined}
      className={available ? "font-semibold" : undefined}
    />
  );
}

export function HistoricalDatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  availableDates,
  eligibleDates,
  disabledDateReasons,
  label = "Review-period end date · New York",
}: DatePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressOpenOnFocusRef = useRef(false);
  const coverageMin = minDate ?? null;
  const coverageMax = maxDate ?? null;
  const effectiveMin = coverageMin ?? FALLBACK_MIN_DATE;
  const effectiveMax = coverageMax ?? FALLBACK_MAX_DATE;
  const knownEligibleDates = useMemo(
    () => sortedEligibleDates(availableDates ?? eligibleDates),
    [availableDates, eligibleDates],
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(formatDateForDisplay(value));
  const [lastValidValue, setLastValidValue] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [displayMonth, setDisplayMonth] = useState(() => resolveOpeningMonth({
    value,
    lastValidValue: value,
    eligibleDates: knownEligibleDates,
    minDate: effectiveMin,
    maxDate: effectiveMax,
    today: todayInNewYork(),
  }));
  const minMonth = canonicalToDate(effectiveMin) ?? new Date(2021, 0, 1);
  const maxMonth = canonicalToDate(effectiveMax) ?? new Date(2026, 11, 31);
  const monthOptions = useMemo(
    () => CALENDAR_MONTHS.map((label, monthIndex) => ({ label, monthIndex })),
    [],
  );
  const yearOptions = useMemo(
    () => Array.from({ length: maxMonth.getFullYear() - minMonth.getFullYear() + 1 }, (_, index) => minMonth.getFullYear() + index),
    [maxMonth, minMonth],
  );

  const reasonForDate = (dateValue: string): string | null => {
    return historicalDateReason(dateValue, knownEligibleDates, coverageMin, coverageMax, disabledDateReasons);
  };

  const nearestEligibleHint = (dateValue: string): string => {
    if (dateValue < effectiveMin || dateValue > effectiveMax) return "";
    return "";
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
      closePopover(false);
    }
    return true;
  };

  const chooseDate = (date: Date | undefined) => {
    if (!date) return;
    commit(dateToCanonical(date));
  };

  const moveToRelativeDate = (direction: -1 | 1) => {
    const current = canonicalToDate(parseDateText(draft) ?? parseDateText(value) ?? effectiveMax);
    if (!current) return;
    current.setDate(current.getDate() + direction);
    commit(dateToCanonical(current));
  };

  const latestIndexedDate = latestEligibleDate(knownEligibleDates);
  const today = todayInNewYork();
  const canChooseToday = !reasonForDate(today);
  const selectedDate = canonicalToDate(value);
  const selectedDateIsEligible = Boolean(selectedDate);
  const navigationDate = parseDateText(draft) ?? value;
  const previousEligibleDate = (() => {
    const date = canonicalToDate(navigationDate);
    if (!date) return null;
    date.setDate(date.getDate() - 1);
    const candidate = dateToCanonical(date);
    return reasonForDate(candidate) ? null : candidate;
  })();
  const nextEligibleDate = (() => {
    const date = canonicalToDate(navigationDate);
    if (!date) return null;
    date.setDate(date.getDate() + 1);
    const candidate = dateToCanonical(date);
    return reasonForDate(candidate) ? null : candidate;
  })();
  const currentMonth = clampDisplayMonth(displayMonth, effectiveMin, effectiveMax);
  const currentMonthKey = currentMonth.getMonth().toString();

  const synchronizeDisplayMonth = () => {
    setDisplayMonth(resolveOpeningMonth({
      value: parseDateText(draft) ?? value,
      lastValidValue,
      eligibleDates: knownEligibleDates,
      minDate: effectiveMin,
      maxDate: effectiveMax,
      today,
    }));
  };

  useEffect(() => {
    setDraft(formatDateForDisplay(value));
    setLastValidValue(value);
    setError(null);
  }, [value]);

  useEffect(() => {
    if (!open) synchronizeDisplayMonth();
  // Keep a closed picker synchronized with controlled values and metadata; an open picker belongs to the user's browsing state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverageMax, coverageMin, knownEligibleDates, lastValidValue, open, value]);

  const closePopover = (nextOpen: boolean) => {
    if (nextOpen && !open) synchronizeDisplayMonth();
    setOpen(nextOpen);
    if (!nextOpen) {
      suppressOpenOnFocusRef.current = true;
      requestAnimationFrame(() => inputRef.current?.focus());
    }
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
              if (suppressOpenOnFocusRef.current) {
                suppressOpenOnFocusRef.current = false;
                return;
              }
              closePopover(true);
            }}
            onClick={() => closePopover(true)}
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
                 setDraft(formatDateForDisplay(lastValidValue));
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
                      setDisplayMonth(monthSelection(
                        currentMonth.getFullYear(),
                        Number(event.target.value),
                        effectiveMin,
                        effectiveMax,
                      ));
                    }}
                  >
                    {monthOptions.map(({ label: monthName, monthIndex }) => <option key={monthIndex} value={monthIndex}>{monthName}</option>)}
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
                      setDisplayMonth(yearSelection(nextYear, currentMonth.getMonth(), effectiveMin, effectiveMax));
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
                  onMonthChange={(nextMonth) => setDisplayMonth(clampDisplayMonth(nextMonth, effectiveMin, effectiveMax))}
                  onSelect={chooseDate}
                  fromMonth={minMonth}
                  toMonth={maxMonth}
                  captionLayout="label"
                   modifiers={{
                     available: (knownEligibleDates ?? [])
                       .map((date) => canonicalToDate(date))
                       .filter((date): date is Date => Boolean(date)),
                   }}
                  disabled={(date) => Boolean(reasonForDate(dateToCanonical(date)))}
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
                 Dates remain selectable across weekends, holidays, missing sessions, and contract transitions. Availability is resolved after selection.
              </p>
              <div className="grid grid-cols-2 gap-1 border-t border-border px-3 pt-2">
                <Button type="button" variant="outline" size="sm" className="h-7 min-w-0 px-2 text-[10px]" aria-label="Previous calendar date" onClick={() => moveToRelativeDate(-1)} disabled={!previousEligibleDate}>
                  <ChevronLeft size={12} aria-hidden="true" /> Previous
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 min-w-0 px-2 text-[10px]" aria-label="Next calendar date" onClick={() => moveToRelativeDate(1)} disabled={!nextEligibleDate}>
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
      {!knownEligibleDates && <p className="text-[10px] text-muted-foreground">Waiting for indexed-date metadata.</p>}
    </div>
  );
}