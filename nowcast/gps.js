// nowcast/gps.js - Wallowa Weather's "My location": the phone's GPS position (watchPosition, high accuracy) and the way the phone points
// (iPhone: webkitCompassHeading after DeviceOrientationEvent.requestPermission() from a tap; Android: deviceorientationabsolute). The
// position is only drawn on this phone: nothing here sends or saves it.
'use strict';

export function createGps({ onChange = () => {}, onError = () => {} } = {}) {
  let me = null;
  let on = false;
  let watchId = null;
  let heading = null;
  let spread = 30;
  let oriFlag = false;
  let lastSentH = null;

  function ok(pos) {
    const h = (heading != null) ? heading : ((pos.coords.heading != null && isFinite(pos.coords.heading) && pos.coords.speed > 1) ? pos.coords.heading : null);
    me = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, alt: pos.coords.altitude, altAcc: pos.coords.altitudeAccuracy, t: pos.timestamp || Date.now(), heading: h, spread };
    onChange(me);
  }

  let warned = false;   // a watch with no fix times out every 60 s: say so once per switch-on, not every time
  function bad(err) {
    if (err && err.code === 1) { onError('Location is off for this app. Allow it in your phone’s settings to see where you are.'); stop(); return; }
    if (!warned) { warned = true; onError('Still looking for your GPS position. With no cell service the first fix can take a minute or two; open sky helps.'); }
  }

  function onOri(e) {
    let h = null, sp = 30;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      h = e.webkitCompassHeading;
      if (typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy > 0) sp = Math.max(15, Math.min(45, e.webkitCompassAccuracy));
    } else if (e.absolute && typeof e.alpha === 'number') {
      h = (360 - e.alpha) % 360;
    }
    if (h === null) return;

    const sa = globalThis.screen && screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : (typeof globalThis.orientation === 'number' ? globalThis.orientation : 0);
    h = (h + sa + 360) % 360;

    if ((lastSentH === null || Math.abs(((h - lastSentH + 540) % 360) - 180) >= 2) || sp !== spread) {
      heading = h;
      spread = sp;
      lastSentH = h;
      if (me) { me.heading = h; me.spread = sp; onChange(me); }
    }
  }

  function listen() {
    if (oriFlag) return;
    oriFlag = true;
    const evName = ('ondeviceorientationabsolute' in globalThis) ? 'deviceorientationabsolute' : 'deviceorientation';
    globalThis.addEventListener(evName, onOri);
  }

  const api = {
    start() {
      if (on) return true;
      if (!navigator.geolocation) { onError('This browser can’t share your location.'); return false; }
      on = true; warned = false;
      watchId = navigator.geolocation.watchPosition(ok, bad, { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 });
      // Android: no permission step for the compass (only the iPhone's needs a tap), so the cone can show from the first fix
      const D = globalThis.DeviceOrientationEvent;
      if (D && typeof D.requestPermission !== 'function') listen();
      return true;
    },
    stop() {
      if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (oriFlag) { globalThis.removeEventListener('deviceorientationabsolute', onOri); globalThis.removeEventListener('deviceorientation', onOri); oriFlag = false; }
      on = false;
      me = null;
      heading = null;
      spread = 30;
      lastSentH = null;
      onChange(null);
    },
    askCompass() {
      const D = globalThis.DeviceOrientationEvent;
      if (!D) return;
      if (typeof D.requestPermission === 'function') {
        D.requestPermission().then((s) => { if (s === 'granted') listen(); }).catch(() => {});
      } else {
        listen();
      }
    },
    get on() { return on; },
    get fix() { return me; }
  };
  const stop = () => api.stop();   // bad() needs it in scope (location refused)
  return api;
}
