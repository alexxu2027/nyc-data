// A clicked bus (ADR-018), in plain words: which route and where it's going, its next stop, how
// fresh Bus Time's GPS report is, and which bus it is. Everything comes from the bus's own map
// feature (the drawer re-renders on each 60 s poll and on its clock tick), so there is no
// detail endpoint, as for subway trains.
import { fmtAgo } from '../../core';
import { headsignOnly } from '../../core/bus';
import type { FeatureProps } from '../../types';
import { Blank, Line, Readout } from '../../ui';
import { useClock } from '../hooks';
import { Text } from './common';
import { bulletInk } from './train';

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);


export function BusView({ props }: { props: Partial<FeatureProps> | undefined }) {
  const now = useClock();
  const route = s(props?.route);
  if (!props || !route) return <Line muted>NO FURTHER DETAIL FOR THIS BUS</Line>;
  const color = s(props.route_color) ?? '#0039a6';
  const seen = s(props.seen_at);
  const since = s(props.since);
  const vehicle = s(props.vehicle);
  return (
    <>
      <Readout
        k="ROUTE"
        v={
          <>
            <span className="drw-bullet" style={{ background: color, color: bulletInk(color) }}>
              {route}
            </span>{' '}
            {s(props.route_name) ?? `${route} bus`}
          </>
        }
      />
      <Readout k="GOING TO" v={headsignOnly(s(props.headsign)) ?? '--'} />
      <Readout k="NEXT STOP" v={s(props.next_name) ?? s(props.next_stop) ?? '--'} r={since ? `SINCE ${fmtAgo(since, now).toUpperCase()}` : undefined} />
      <Readout k="SERVICE" v={(s(props.service_name) ?? 'Local').toUpperCase()} />
      <Readout k="BUS" v={vehicle ? `#${vehicle}` : '--'} />
      <Readout k="GPS UPDATE" v={seen ? fmtAgo(seen, now) : '--'} />
      <Blank />
      <Text muted>
        Each bus reports its own GPS position to MTA Bus Time about every 30 seconds, so its spot on the map is where it
        last reported, not an estimate.
      </Text>
    </>
  );
}
