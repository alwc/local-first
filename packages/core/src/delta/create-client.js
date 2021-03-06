// @flow

import type { Client } from '../types';
import type {
    Persistence,
    OldNetwork,
    Network,
    PersistentClock,
    DeltaPersistence,
    FullPersistence,
    NetworkCreator,
} from '../types';
import { peerTabAwareNetwork } from '../peer-tabs';
import type { HLC } from '../../../hybrid-logical-clock';
import * as hlc from '../../../hybrid-logical-clock';
import { type Schema } from '../../../nested-object-crdt/src/schema.js';
import deepEqual from 'fast-deep-equal';
import { type PeerChange } from '../types';

import {
    newCollection,
    getCollection,
    onCrossTabChanges,
    type CRDTImpl,
    type CollectionState,
} from '../shared';

const genId = () =>
    Math.random()
        .toString(36)
        .slice(2);

import { type ClientMessage, type ServerMessage } from '../server';
export const getMessages = async function<Delta, Data>(
    persistence: DeltaPersistence,
    reconnected: boolean,
): Promise<Array<ClientMessage<Delta, Data>>> {
    const items: Array<?ClientMessage<Delta, Data>> = await Promise.all(
        persistence.collections.map(
            async (
                collection: string,
            ): Promise<?ClientMessage<Delta, Data>> => {
                const deltas = await persistence.deltas(collection);
                const serverCursor = await persistence.getServerCursor(
                    collection,
                );
                if (deltas.length || serverCursor == null || reconnected) {
                    // console.log('messages yeah', serverCursor);
                    return {
                        type: 'sync',
                        collection,
                        serverCursor,
                        deltas: deltas.map(({ node, delta }) => ({
                            node,
                            delta,
                        })),
                    };
                }
            },
        ),
    );
    return items.filter(Boolean);
};

export const handleMessages = async function<Delta, Data>(
    crdt: CRDTImpl<Delta, Data>,
    persistence: DeltaPersistence,
    messages: Array<ServerMessage<Delta, Data>>,
    state: { [colid: string]: CollectionState<Data, any> },
    recvClock: HLC => void,
    sendCrossTabChanges: PeerChange => mixed,
): Promise<Array<ClientMessage<Delta, Data>>> {
    console.log('RECV', messages);
    const res: Array<?ClientMessage<Delta, Data>> = await Promise.all(
        messages.map(async (msg): Promise<?ClientMessage<Delta, Data>> => {
            if (msg.type === 'sync') {
                const col = state[msg.collection];

                const changed = {};
                msg.deltas.forEach(delta => {
                    changed[delta.node] = true;
                });

                const deltasWithStamps = msg.deltas.map(delta => ({
                    ...delta,
                    stamp: crdt.deltas.stamp(delta.delta),
                }));

                const changedIds = Object.keys(changed);
                // console.log('applying deltas', msg.serverCursor);
                const data = await persistence.applyDeltas(
                    msg.collection,
                    deltasWithStamps,
                    msg.serverCursor,
                    (data, delta) => crdt.deltas.apply(data, delta),
                );

                if (col.listeners.length) {
                    const changes = changedIds.map(id => ({
                        id,
                        value: crdt.value(data[id]),
                    }));
                    col.listeners.forEach(listener => {
                        listener(changes);
                    });
                }
                changedIds.forEach(id => {
                    // Only update the cache if the node has already been cached
                    if (state[msg.collection].cache[id] != null) {
                        state[msg.collection].cache[id] = data[id];
                    }
                    if (col.itemListeners[id]) {
                        col.itemListeners[id].forEach(fn =>
                            fn(crdt.value(data[id])),
                        );
                    }
                });

                if (changedIds.length) {
                    // console.log(
                    //     'Broadcasting to client-level listeners',
                    //     changedIds,
                    // );
                    sendCrossTabChanges({
                        col: msg.collection,
                        nodes: changedIds,
                    });
                }

                let maxStamp = null;
                msg.deltas.forEach(delta => {
                    const stamp = crdt.deltas.stamp(delta.delta);
                    if (maxStamp == null || stamp > maxStamp) {
                        maxStamp = stamp;
                    }
                });
                if (maxStamp) {
                    recvClock(hlc.unpack(maxStamp));
                }
                return {
                    type: 'ack',
                    collection: msg.collection,
                    serverCursor: msg.serverCursor,
                };
            } else if (msg.type === 'ack') {
                await persistence.deleteDeltas(msg.collection, msg.deltaStamp);
            }
        }),
    );
    return res.filter(Boolean);
};

export const initialState = function<Data>(
    collections: Array<string>,
): { [key: string]: CollectionState<Data, any> } {
    const state = {};
    collections.forEach(id => (state[id] = newCollection()));
    return state;
};

const tabIsolatedNetwork = function<SyncStatus>(
    network: Network<SyncStatus>,
): OldNetwork<SyncStatus> {
    const connectionListeners = [];
    let currentSyncStatus = network.initial;
    const sync = network.createSync(
        () => {},
        (status: SyncStatus) => {
            currentSyncStatus = status;
            connectionListeners.forEach(f => f(currentSyncStatus));
        },
        () => {
            // do nothing
        },
    );
    return {
        setDirty: () => sync(false),
        onSyncStatus: fn => {
            connectionListeners.push(fn);
        },
        getSyncStatus() {
            return currentSyncStatus;
        },
        sendCrossTabChanges(peerChange) {},
    };
};

function createClient<Delta, Data, SyncStatus>(
    crdt: CRDTImpl<Delta, Data>,
    schemas: { [colid: string]: Schema },
    clock: PersistentClock,
    persistence: DeltaPersistence,
    createNetwork: NetworkCreator<Delta, Data, SyncStatus>,
): Client<SyncStatus> {
    const state = initialState(persistence.collections);

    console.log();

    const innerNetwork = createNetwork(
        clock.now.node,
        fresh => getMessages(persistence, fresh),
        (messages, sendCrossTabChanges) =>
            handleMessages(
                crdt,
                persistence,
                messages,
                state,
                clock.recv,
                sendCrossTabChanges,
            ),
    );

    const network = persistence.tabIsolated
        ? tabIsolatedNetwork(innerNetwork)
        : peerTabAwareNetwork((msg: PeerChange) => {
              return onCrossTabChanges(
                  crdt,
                  persistence,
                  state[msg.col],
                  msg.col,
                  msg.nodes,
              );
          }, innerNetwork);

    return {
        sessionId: clock.now.node,
        getStamp: clock.get,
        setDirty: network.setDirty,
        getCollection<T>(colid: string) {
            return getCollection(
                colid,
                crdt,
                persistence,
                state[colid],
                clock.get,
                network.setDirty,
                network.sendCrossTabChanges,
                schemas[colid],
            );
        },
        onSyncStatus(fn) {
            network.onSyncStatus(fn);
        },
        getSyncStatus() {
            return network.getSyncStatus();
        },
    };
}

export default createClient;
