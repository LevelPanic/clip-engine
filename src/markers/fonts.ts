// The caption and text fonts, loaded once for the Studio player and the renderer (Google Fonts through
// Remotion, so the export and the preview draw the same glyphs).
import { loadFont as barlow } from '@remotion/google-fonts/BarlowCondensed';
import { loadFont as luckiest } from '@remotion/google-fonts/LuckiestGuy';
import { loadFont as poppins } from '@remotion/google-fonts/Poppins';
import { loadFont as montserrat } from '@remotion/google-fonts/Montserrat';
import type { CaptionLook } from '../core/captionLooks';

const families: Record<CaptionLook['font'], string> = {
  barlow: barlow('italic', { weights: ['800', '900'], subsets: ['latin'] }).fontFamily,
  montserrat: montserrat('italic', { weights: ['800'], subsets: ['latin'] }).fontFamily,
  luckiest: luckiest('normal', { weights: ['400'], subsets: ['latin'] }).fontFamily,
  poppins: poppins('normal', { weights: ['600', '700'], subsets: ['latin'] }).fontFamily,
};

/** The CSS font family for a look's font key (Montserrat's upright weights are loaded in context.ts). */
export const fontFamilyOf = (font: CaptionLook['font']) => families[font];
