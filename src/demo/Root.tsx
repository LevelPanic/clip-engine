import React from 'react';
import { Composition } from 'remotion';
import { TikTokDemo } from './Demo';

export const DemoRoot: React.FC = () => (
  <Composition id="TikTokDemo" component={TikTokDemo} width={1920} height={1080} fps={30} durationInFrames={900} />
);
