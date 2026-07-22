/** 会议首页所有同步入口共享同一轮任务，避免轮询与手动刷新同时走「检查后创建」。 */
export function createMeetingHomeSync(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const task = Promise.resolve().then(run);
    let shared: Promise<void>;
    shared = task.finally(() => {
      if (inFlight === shared) inFlight = null;
    });
    inFlight = shared;
    return inFlight;
  };
}
