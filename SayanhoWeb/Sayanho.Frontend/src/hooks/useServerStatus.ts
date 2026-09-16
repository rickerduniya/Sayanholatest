// Subscribe to the shared backend wake-up / keep-alive state.

import { useEffect, useState } from 'react';
import { serverWake, ServerStatusSnapshot } from '../services/serverWakeService';

export const useServerStatus = (): ServerStatusSnapshot => {
    const [snapshot, setSnapshot] = useState<ServerStatusSnapshot>(() => serverWake.getSnapshot());

    useEffect(() => serverWake.subscribe(setSnapshot), []);

    return snapshot;
};
