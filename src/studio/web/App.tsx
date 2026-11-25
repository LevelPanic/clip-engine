import React, { useEffect, useState } from 'react';
import { parseRoute, type Route } from './api';
import { Library } from './Library';
import { VideoPage } from './VideoPage';
import { Editor } from './Editor';
import { Review } from './Review';
import { Jobs } from './Jobs';
import { Settings } from './Settings';
import { DiscoverySwitch } from './Discovery';
import { NavEnd } from './ui';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return <NavEnd.Provider value={<DiscoverySwitch />}>{page(route)}</NavEnd.Provider>;
}

function page(route: Route) {
  if (route.page === 'video') return <VideoPage key={route.id} videoId={route.id} />;
  if (route.page === 'clip') return <Editor key={route.id} clipId={route.id} />;
  if (route.page === 'review') return <Review clipId={route.id} />;
  if (route.page === 'jobs') return <Jobs />;
  if (route.page === 'settings') return <Settings />;
  return <Library />;
}
