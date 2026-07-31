export interface NightscoutDuration {
  hours?: number;
  mins?: number;
  secs?: number;
  msecs: number;
}

function weeks(value: number): NightscoutDuration {
  return {
    mins: value * 7 * 24 * 60,
    secs: value * 7 * 24 * 60 * 60,
    msecs: value * 7 * 24 * 60 * 60 * 1_000,
  };
}

function days(value: number): NightscoutDuration {
  return {
    hours: value * 24,
    mins: value * 24 * 60,
    secs: value * 24 * 60 * 60,
    msecs: value * 24 * 60 * 60 * 1_000,
  };
}

function hours(value: number): NightscoutDuration {
  return {
    mins: value * 60,
    secs: value * 60 * 60,
    msecs: value * 60 * 60 * 1_000,
  };
}

function mins(value: number): NightscoutDuration {
  return { secs: value * 60, msecs: value * 60 * 1_000 };
}

function secs(value: number): NightscoutDuration {
  return { msecs: value * 1_000 };
}

function msecs(value: number): NightscoutDuration {
  return { mins: value / 1_000 / 60, secs: value / 1_000, msecs: value };
}

/** Direct Workers-safe port of locked v15.0.7 lib/times.js. */
export const nightscoutTimes = {
  week: (): NightscoutDuration => weeks(1),
  weeks,
  day: (): NightscoutDuration => days(1),
  days,
  hour: (): NightscoutDuration => hours(1),
  hours,
  min: (): NightscoutDuration => mins(1),
  mins,
  sec: (): NightscoutDuration => secs(1),
  secs,
  msec: (): NightscoutDuration => msecs(1),
  msecs,
};
