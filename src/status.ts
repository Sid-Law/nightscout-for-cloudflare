export function nightscoutStatus(
  now = new Date(),
  authDefaultRoles = "readable",
): Record<string, unknown> {
  return {
    status: "ok",
    name: "Nightscout",
    version: "15.0.7",
    serverTime: now.toISOString(),
    serverTimeEpoch: now.getTime(),
    apiEnabled: true,
    careportalEnabled: true,
    boluscalcEnabled: false,
    runtimeState: "loaded",
    settings: {
      units: "mg/dl",
      timeFormat: 24,
      dayStart: 7,
      dayEnd: 21,
      nightMode: false,
      editMode: false,
      showRawbg: "never",
      customTitle: "Nightscout",
      theme: "default",
      language: "en",
      scaleY: "log",
      showPlugins: "bgnow delta direction timeago devicestatus upbat errorcodes profile bolus dbsize runtimestate basal careportal",
      showForecast: "ar2",
      focusHours: 3,
      heartbeat: 60,
      authDefaultRoles,
      authenticationPromptOnLoad: false,
      adminNotifiesEnabled: false,
      alarmTypes: [],
      alarmUrgentHigh: false,
      alarmHigh: false,
      alarmLow: false,
      alarmUrgentLow: false,
      alarmTimeagoWarn: false,
      alarmTimeagoWarnMins: 15,
      alarmTimeagoUrgent: false,
      alarmTimeagoUrgentMins: 30,
      alarmPumpBatteryLow: false,
      thresholds: {
        bgHigh: 260,
        bgTargetTop: 180,
        bgTargetBottom: 80,
        bgLow: 55,
      },
      enable: [
        "bgnow",
        "delta",
        "direction",
        "timeago",
        "devicestatus",
        "upbat",
        "errorcodes",
        "profile",
        "bolus",
        "dbsize",
        "runtimestate",
        "basal",
        "careportal",
        "ar2",
      ],
    },
    extendedSettings: {},
  };
}

/** Exact field set/order used by locked Nightscout's Socket.IO authorize path. */
export function nightscoutWebsocketStatus(
  now = new Date(),
  activeProfile?: unknown,
  authDefaultRoles = "readable",
): Record<string, unknown> {
  const httpStatus = nightscoutStatus(now, authDefaultRoles);
  const websocketStatus: Record<string, unknown> = {
    status: "ok",
    name: "Nightscout",
    version: "15.0.7",
    versionNum: 150007,
    serverTime: now.toISOString(),
    apiEnabled: true,
    careportalEnabled: true,
    boluscalcEnabled: false,
    settings: httpStatus.settings,
    extendedSettings: {},
  };
  if (activeProfile !== undefined && activeProfile !== null) {
    websocketStatus.activeProfile = activeProfile;
  }
  return websocketStatus;
}
