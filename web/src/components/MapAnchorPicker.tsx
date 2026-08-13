import {useEffect, useRef, useState} from 'react';
import {importLibrary, setOptions} from '@googlemaps/js-api-loader';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Text} from '@astryxdesign/core/Text';

/** Partial on purpose: a half-typed coordinate pair must not invent the other half. */
export interface AnchorValue {
  lat: number | null;
  lng: number | null;
}

/**
 * Drawn so the employer can see the clock-in zone (design §6.2). Display only — the
 * backend owns the radius it actually enforces (ANCHOR_RADIUS_M there, env-overridable)
 * and never accepts one from this form.
 */
const ANCHOR_RADIUS_M = 1000;

const WORLD_CENTER = {lat: 20, lng: 0};
const WORLD_ZOOM = 2;
const ANCHOR_ZOOM = 15;

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
// Must precede the first importLibrary(); at module scope it cannot be missed or repeated.
if (MAPS_KEY) setOptions({key: MAPS_KEY, v: 'weekly'});

// ~0.1 m. The longer tail is GPS noise the employer would only have to scroll past.
const round = (n: number) => Math.round(n * 1e6) / 1e6;

interface MapAnchorPickerProps {
  value: AnchorValue;
  onChange: (value: AnchorValue) => void;
}

export function MapAnchorPicker({value, onChange}: MapAnchorPickerProps) {
  const {lat, lng} = value;
  const point = lat !== null && lng !== null ? {lat, lng} : null;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);

  // Map listeners are attached once, when the API resolves. Reading these through refs
  // keeps them from having to be torn down and rebuilt on every parent render. Declared
  // above the map effect so both hold this render's values before the map is created.
  const onChangeRef = useRef(onChange);
  const pointRef = useRef(point);
  useEffect(() => {
    onChangeRef.current = onChange;
    pointRef.current = point;
  });

  const [isReady, setIsReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!MAPS_KEY || !container) return;

    let cancelled = false;
    let dispose: (() => void) | null = null;

    Promise.all([importLibrary('maps'), importLibrary('marker')])
      .then(([{Circle, Map}, {Marker}]) => {
        if (cancelled) return;

        // The Maps canvas cannot read CSS custom properties, so resolve the accent off the
        // container — whose only reason to set `color` is this line — and hand it over.
        const accent = getComputedStyle(container).color;

        const start = pointRef.current;
        const map = new Map(container, {
          center: start ?? WORLD_CENTER,
          zoom: start ? ANCHOR_ZOOM : WORLD_ZOOM,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        // ponytail: google.maps.Marker, not AdvancedMarkerElement, which renders nothing
        // unless the map is created with a Cloud-console Map ID. Ceiling is Google's
        // deprecation window; upgrade path is a VITE_GOOGLE_MAPS_ID env var plus
        // `mapId` above and `gmpDraggable` here.
        const marker = new Marker({map, draggable: true, visible: false});
        const circle = new Circle({
          map,
          radius: ANCHOR_RADIUS_M,
          visible: false,
          clickable: false,
          strokeColor: accent,
          strokeOpacity: 0.8,
          strokeWeight: 2,
          fillColor: accent,
          fillOpacity: 0.12,
        });

        const commit = (position: google.maps.LatLng | null | undefined) => {
          if (position) {
            onChangeRef.current({lat: round(position.lat()), lng: round(position.lng())});
          }
        };
        const listeners = [
          map.addListener('click', (e: google.maps.MapMouseEvent) => commit(e.latLng)),
          marker.addListener('dragend', (e: google.maps.MapMouseEvent) => commit(e.latLng)),
          // Recentred here rather than through onChange: setPosition() on a marker the
          // user is still holding fights the drag.
          marker.addListener('drag', (e: google.maps.MapMouseEvent) => {
            if (e.latLng) circle.setCenter(e.latLng);
          }),
        ];

        mapRef.current = map;
        markerRef.current = marker;
        circleRef.current = circle;
        dispose = () => {
          listeners.forEach((listener) => listener.remove());
          marker.setMap(null);
          circle.setMap(null);
          mapRef.current = null;
          markerRef.current = null;
          circleRef.current = null;
        };
        setIsReady(true);

        if (!start) centerOnGrantedLocation(map, pointRef);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    const circle = circleRef.current;
    if (!map || !marker || !circle) return;

    if (lat === null || lng === null) {
      marker.setVisible(false);
      circle.setVisible(false);
      return;
    }

    const position = {lat, lng};
    marker.setPosition(position);
    marker.setVisible(true);
    circle.setCenter(position);
    circle.setVisible(true);

    // Only chase an anchor that landed off-screen. A pin dropped inside the current view
    // is exactly where the user put it, and recentring after every drag would yank the map.
    if (!map.getBounds()?.contains(position)) {
      map.setCenter(position);
      if ((map.getZoom() ?? 0) < ANCHOR_ZOOM) map.setZoom(ANCHOR_ZOOM);
    }
  }, [lat, lng, isReady]);

  const useMyLocation = () =>
    new Promise<void>((resolve) => {
      setGeoError(null);
      if (!navigator.geolocation) {
        setGeoError('This browser cannot share a location. Enter the coordinates below.');
        resolve();
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          onChange({
            lat: round(position.coords.latitude),
            lng: round(position.coords.longitude),
          });
          resolve();
        },
        () => {
          // The GeolocationPositionError is not surfaced: its codes describe the browser,
          // and the way forward is the same whichever one it is.
          setGeoError('Could not read your location. Allow access, or enter the coordinates below.');
          resolve();
        },
        {timeout: 10_000},
      );
    });

  return (
    <VStack gap={3}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button
          label="Use my location"
          variant="secondary"
          size="sm"
          clickAction={useMyLocation}
        />
        <Text type="supporting" color="secondary">
          Your crew can clock in within {ANCHOR_RADIUS_M} m of this point.
        </Text>
      </HStack>

      {geoError && (
        <Banner
          status="warning"
          title={geoError}
          isDismissable
          onDismiss={() => setGeoError(null)}
        />
      )}

      {!MAPS_KEY && (
        <Banner
          status="info"
          title="Map unavailable"
          description="VITE_GOOGLE_MAPS_KEY is not set, so enter the anchor coordinates directly."
        />
      )}

      {loadFailed && (
        <Banner
          status="warning"
          title="Map could not load"
          description="Enter the anchor coordinates directly."
        />
      )}

      {MAPS_KEY && !loadFailed && (
        // ponytail: Astryx has no map component and the Maps JS API mounts into a DOM node
        // it takes over, so this raw element is the escape hatch. Every value on it is a
        // token or ratio, and `color` exists only so the circle can resolve the accent.
        <div
          ref={containerRef}
          style={{
            aspectRatio: '16 / 9',
            width: '100%',
            color: 'var(--color-accent)',
            backgroundColor: 'var(--color-background-muted)',
            borderRadius: 'var(--radius-container)',
            overflow: 'hidden',
          }}
        />
      )}

      <HStack gap={3}>
        {/* hasClear is what widens onChange to number | null — without it an emptied
            field is never committed and snaps back to the old value on blur. */}
        <NumberInput
          label="Latitude"
          value={lat}
          onChange={(next) => onChange({lat: next, lng})}
          hasClear
          min={-90}
          max={90}
          step={0.000001}
          placeholder="-33.8688"
          width="100%"
        />
        <NumberInput
          label="Longitude"
          value={lng}
          onChange={(next) => onChange({lat, lng: next})}
          hasClear
          min={-180}
          max={180}
          step={0.000001}
          placeholder="151.2093"
          width="100%"
        />
      </HStack>
    </VStack>
  );
}

/**
 * Centres on the visitor only when geolocation was *already* granted. permissions.query()
 * reports a standing grant without raising the permission dialog — prompting on first
 * paint, before the user has asked for anything, is hostile.
 */
function centerOnGrantedLocation(
  map: google.maps.Map,
  pointRef: {current: {lat: number; lng: number} | null},
) {
  navigator.permissions
    ?.query({name: 'geolocation'})
    .then(({state}) => {
      if (state !== 'granted') return;
      navigator.geolocation.getCurrentPosition((position) => {
        // The user may have picked an anchor while this was in flight; that wins.
        if (pointRef.current) return;
        map.setCenter({lat: position.coords.latitude, lng: position.coords.longitude});
        map.setZoom(ANCHOR_ZOOM);
      });
    })
    .catch(() => {
      // Firefox rejects the geolocation permission name outright; the world view stands.
    });
}
