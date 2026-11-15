// Conductor-owned (plan §7.1). Units talk only through the store (core).
import { useEffect } from 'react';
import { boot } from './core';
import { Drawer } from './drawer/Drawer';
import { MapView } from './map/MapView';
import { Shell } from './shell/Shell';
import { Gallery } from './ui/Gallery';

export default function App() {
  const gallery = new URLSearchParams(location.search).has('gallery');
  useEffect(() => (gallery ? undefined : boot()), [gallery]);
  return gallery ? <Gallery /> : <Shell map={<MapView />} drawer={<Drawer />} />;
}
