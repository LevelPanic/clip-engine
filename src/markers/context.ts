// Shared helpers for marker components.
import { createContext, useContext } from 'react';
import { loadFont } from '@remotion/google-fonts/Montserrat';

export const { fontFamily: FONT } = loadFont('normal', { weights: ['700', '800', '900'], subsets: ['latin'] });

/** `seam`: where the two pictures of a split layout meet at this moment, as a fraction of the height; absent when the picture is not split. */
export const ClipContext = createContext<{ assetBase: string; seam?: number }>({ assetBase: '/' });

/** useAsset()('sfx/boom.wav') → a URL that works in the Studio and in the renderer. */
export const useAsset = () => {
  const { assetBase } = useContext(ClipContext);
  return (rel: string) => assetBase + rel.split('/').map(encodeURIComponent).join('/');
};
