/** What a conformance suite gets from the provider under test. */
export interface Subject<T> {
  subject: T;
  /** Release anything the subject created (temp dirs, buckets, servers). */
  cleanup(): Promise<void>;
}
