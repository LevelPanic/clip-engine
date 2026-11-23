import React from 'react';
import { Composition } from 'remotion';
import { ClipComposition } from './ClipComposition';
import { durationInFrames, placeholderProps, WIDTH, HEIGHT, type ClipProps } from './props';
import { FPS } from '../core/time';

export const Root: React.FC = () => (
  <Composition
    id="Clip"
    component={ClipComposition}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    durationInFrames={durationInFrames(placeholderProps)}
    defaultProps={placeholderProps}
    calculateMetadata={({ props }: { props: ClipProps }) => ({ durationInFrames: durationInFrames(props) })}
  />
);
