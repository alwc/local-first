// @flow
import * as crdt from '../nested-object-crdt';
import type { Delta, CRDT as Data } from '../nested-object-crdt';
import type { Schema } from '../nested-object-crdt/src/schema.js';
import make, { onMessage, getMessages } from '../core/src/server';
import type {
    ClientMessage,
    ServerMessage,
    CursorType,
    ServerState,
} from '../core/src/server';

import path from 'path';
import fs from 'fs';
import levelup from 'levelup';
import leveldown from 'leveldown';
import setupPersistence from './sqlite-persistence';

import { getBlob, putBlob } from './blob';
import { post } from './poll';
import { onWebsocket } from './websocket';

export const makeServer = (schema: Schema, dataPath: string) =>
    make<Delta, Data>(crdt, setupPersistence(dataPath), (
        collectionId /*: string*/,
    ) /*: Schema*/ => {
        return schema;
    });

export const runServer = <Delta, Data>(
    port: number,
    dataPath: string,
    server: ServerState<Delta, Data>,
) => {
    const express = require('express');
    const ws = require('express-ws');

    const app = express();
    const wsInst = ws(app);
    app.use(require('cors')({ exposedHeaders: ['etag'] }));
    app.use(require('body-parser').json());

    app.get('/blob/:name', (req, res) => {
        console.log(`Getting blob ${req.params['name']}`);
        const filePath = path.join(dataPath, 'blobs', req.params['name']);
        getBlob(filePath, req.get('if-none-match'), res);
    });

    app.put('/blob/:name', (req, res) => {
        console.log(`Updating blob ${req.params['name']}`);
        const filePath = path.join(dataPath, 'blobs', req.params['name']);
        putBlob(filePath, req.body, res);
    });

    app.post('/sync', (req, res) => {
        if (!req.query.sessionId) {
            throw new Error('No sessionId');
        }
        res.json(post(server, req.query.sessionId, req.body));
    });

    const clients = {};

    app.ws('/sync', function(ws, req) {
        if (!req.query.sessionId) {
            console.log('no sessionid');
            throw new Error('No sessionId');
        }
        onWebsocket(server, clients, req.query.sessionId, ws);
    });

    const http = app.listen(port);
    return { http, app, wsInst };
};
