// Live state shared by every page: session (me), socket, containers, jobs, alerts
import { createContext, useContext } from 'react';

export const LiveCtx = createContext(null);
export const useLive = () => useContext(LiveCtx);
