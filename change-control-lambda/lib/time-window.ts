// tslint:disable-next-line:no-var-requires
const ical = require('node-ical');

/**
 * A calendar event describing a "blocked" time window.
 */
export interface CalendarEvent {
  /** The description of the event */
  summary: string;
  /** The time at which the block starts */
  start: Date;
  /** The time at which the block ends */
  end: Date;
  /** The time at which the event was last modified. */
  dtstamp?: Date;
  /** The type of a calendar event */
  type: 'VEVENT' | string;
  /** Parameters to the event, if any. */
  params?: any[];
  /** The type of the boundaries for the event */
  datetype: 'date-time';
}
type Events = { [uuid: string]: CalendarEvent };

/**
 * Evaluates whether a deployment pipeline should have promotions suspended due to the imminent start of a blocked
 * time window.
 *
 * @param ical is an iCal document that describes "blocked" time windows (there needs to be an event only for times
 *             during which promotions should not happen).
 * @param now  is the reference time considered when assessing the need to block or not.
 * @param advanceMarginSec is the padding applied before events (defaults to 1 hour).
 *
 * @returns the events that represent the blocked time, or `undefined` if `now` is not "blocked".
 */
export function shouldBlockPipeline(icalData: string | Buffer, now = new Date(), advanceMarginSec = 3600): CalendarEvent | undefined {
  const events: Events = ical.parseICS(icalData.toString('utf8'));
  const blocks = containingEventsWithMargin(events, now, advanceMarginSec);
  return blocks.length > 0 ? blocks[0] : undefined;
}

function containingEventsWithMargin(events: Events, date: Date, advanceMarginSec: number): CalendarEvent[] {
  const bufferedDate = new Date(date.getTime() + advanceMarginSec * 1_000);
  return Object.values(events)
    .filter(e => e.type === 'VEVENT')
    .filter(e => happensBetween(e, date, bufferedDate));
}

/**
 * Checks whether an event occurs within a specified time period, which should match the following:
 * |------------------<=========EVENT=========>------------------------->
 *                         <WITHIN EVENT>
 *            <OVERLAP AT START>
 *                                      <OVERLAP AT END>
 *               <===COMPLETELY INCLUDES EVENT=====>
 * |------------------<=========EVENT=========>------------------------->
 *
 * @param event    the event being checked.
 * @param fromDate the beginning of the time period.
 * @param toDate   the end of the time period.
 */
function happensBetween(event: CalendarEvent, fromDate: Date, toDate: Date): boolean {
  return isBetween(fromDate, event.start, event.end)
    || isBetween(toDate, event.start, event.end)
    || isBetween(event.start, fromDate, toDate)
    || isBetween(event.end, fromDate, toDate);
}

function isBetween(date: Date, left: Date, right: Date): boolean {
  return date >= left && date <= right;
}
