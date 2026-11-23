import React from 'react';
import { Html5Audio } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import { useAsset } from '../../src/markers/context';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

// The silence is the schema's `gain` hook (the composition turns the clip's sound down); this only plays
// the tone, which stops where the span ends.
export default defineRender<P>({
  Component: ({ params }) => {
    const asset = useAsset();
    return params.sound === 'tone' ? <Html5Audio src={asset('sfx/bleep.wav')} volume={params.volume} /> : null;
  },
});
