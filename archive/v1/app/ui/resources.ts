/** Resource colours (design doc): map dots, chips, swatches, and graph edges carrying a raw item. */
export const RESOURCE_COLOR: Record<string, string> = {
  Desc_OreIron_C: '#D9826B',
  Desc_OreCopper_C: '#F0A45A',
  Desc_Stone_C: '#E8DDC4',
  Desc_Coal_C: '#8C939C',
  Desc_OreGold_C: '#F2CC4B',
  Desc_RawQuartz_C: '#F08CC8',
  Desc_Sulfur_C: '#C9E35A',
  Desc_OreBauxite_C: '#B98557',
  Desc_SAM_C: '#A98BF0',
  Desc_OreUranium_C: '#6EE07A',
  Desc_LiquidOil_C: '#5BA8D9',
  Desc_Water_C: '#6FC7C1',
  Desc_NitrogenGas_C: '#C3D4E8',
};
export const resourceColor = (id: string | null | undefined) => (id && RESOURCE_COLOR[id]) || '#C8CDD3';
