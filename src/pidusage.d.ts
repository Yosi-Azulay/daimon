declare module 'pidusage' {
  interface Stat { cpu: number; memory: number; ppid: number; pid: number; ctime: number; elapsed: number; timestamp: number; }
  function pidusage(pid: number | number[]): Promise<Stat | Record<string, Stat>>;
  export default pidusage;
}
