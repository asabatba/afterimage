// Drag-and-drop payload types shared by the pool, the sample editor and the arrangement lanes.

/** A whole pool sample: the data is the sample id. */
export const SAMPLE_MIME = 'application/x-afterimage-sample';

/** A region of a sample: the data is JSON of `SliceDrag`. */
export const SLICE_MIME = 'application/x-afterimage-slice';

export interface SliceDrag {
  sampleId: string;
  from: number;
  to: number;
}
