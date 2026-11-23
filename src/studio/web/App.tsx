import React, { useEffect, useState } from 'react';
import { parseRoute, type Route } from './api';
import { Library } from './Library';
import { VideoPage } from './VideoPage';
import { Editor } from './Editor';
import { Review } from './Review';
import { Jobs } from './Jobs';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (route.page === 'video') return <VideoPage key={route.id} videoId={route.id} />;
  if (route.page === 'clip') return <Editor key={route.id} clipId={route.id} />;
  if (route.page === 'review') return <Review clipId={route.id} />;
  if (route.page === 'jobs') return <Jobs />;
  return <Library />;
}
