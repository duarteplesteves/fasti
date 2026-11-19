/** Resolves to `unknown` when a column of data type `D` can hold every `T`; otherwise to an error-carrying type. */
export type Accepts<D, T> = [T] extends [D]
  ? unknown
  : {
      readonly "references: the column's type must hold the Resource id type": T;
    };
