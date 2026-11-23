import React from 'react';
import { Html5Audio } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import { useAsset } from '../../src/markers/context';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  Component: ({ params }) => {
    const asset = useAsset();
    return <Html5Audio src={asset(`sfx/${params.sound}`)} volume={params.volume} />;
  },
});
