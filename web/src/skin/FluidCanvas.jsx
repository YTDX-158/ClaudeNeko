/**
 * FluidCanvas.jsx — WebGL 流体背景（Aqua 流体还原）
 * 当壁纸设为「流体」时，全屏 canvas 运行流体模拟；否则不渲染。
 * 监听 skinEngine：流体配置（预设/色相）变化时动态 setParams 换色。
 */
import { useEffect, useRef } from 'react';
import { skinEngine } from './skinEngine.js';
import { attachFluidShader, FLUID_PRESETS, fluidHueColors } from './fluidEngine.js';

/** 由预设 + 色相/饱和/亮度 + 速度/漩涡/色彩数生成当前流体参数。 */
function buildParams() {
  const preset = FLUID_PRESETS[skinEngine.fluid.preset] || FLUID_PRESETS.ocean;
  const hc = fluidHueColors(skinEngine.fluid.hue, skinEngine.fluid.saturation, skinEngine.fluid.brightness);
  // 用户可调：速度 0~100 → 4~44；漩涡 0~40；色彩数 1/2/3
  const speed = 4 + skinEngine.fluid.speed * 0.4;
  const swirl = skinEngine.fluid.swirl;
  const colorCount = skinEngine.fluid.colorCount;
  return { ...preset, color1: hc.color1, color2: hc.color2, color3: hc.color3, speed, swirl, colorCount };
}

export default function FluidCanvas() {
  const canvasRef = useRef(null);
  const handleRef = useRef(null);

  useEffect(() => {
    const sync = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const active = skinEngine.wallpaper.kind === 'fluid';
      // 非流体时隐藏 canvas：避免残留最后一帧流体画面盖住新背景
      canvas.style.display = active ? '' : 'none';
      if (active) {
        if (!handleRef.current) {
          handleRef.current = attachFluidShader(canvas, buildParams());
        } else {
          handleRef.current.setParams(buildParams());
        }
      } else if (handleRef.current) {
        handleRef.current.dispose();
        handleRef.current = null;
      }
    };
    sync();
    const unsub = skinEngine.subscribe(sync);
    return () => {
      unsub();
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="fluid-canvas" aria-hidden="true" />;
}
