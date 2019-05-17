/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { defer as observableDefer, of as observableOf, } from "rxjs";
import { catchError, map, mergeMap, } from "rxjs/operators";
import log from "../../log";
import arrayIncludes from "../../utils/array-includes";
import assert from "../../utils/assert";
import castToObservable from "../../utils/castToObservable";
import isSessionUsable from "./utils/is_session_usable";
/**
 * If session creating fails, retry once session creation/loading.
 * Emit true, if it has succeeded to load, false if there is no data for the
 * given sessionId.
 * @param {string} sessionId
 * @param {MediaKeySession} session
 * @returns {Observable}
 */
function loadPersistentSession(sessionId, session) {
    return observableDefer(function () {
        log.debug("eme: load persisted session", sessionId);
        return castToObservable(session.load(sessionId));
    });
}
/**
 * Create a new Session on the given MediaKeys, corresponding to the given
 * initializationData.
 * If session creating fails, remove the oldest MediaKeySession loaded and
 * retry.
 *
 * /!\ This only creates new sessions.
 * It will fail if sessionsStore already has a MediaKeySession with
 * the given initializationData.
 * @param {Uint8Array} initData
 * @param {string|undefined} initDataType
 * @param {Object} mediaKeysInfos
 * @returns {Observable}
 */
export default function createSession(initData, initDataType, mediaKeysInfos) {
    return observableDefer(function () {
        var keySystemOptions = mediaKeysInfos.keySystemOptions, mediaKeySystemAccess = mediaKeysInfos.mediaKeySystemAccess, sessionsStore = mediaKeysInfos.sessionsStore, sessionStorage = mediaKeysInfos.sessionStorage;
        var mksConfig = mediaKeySystemAccess.getConfiguration();
        var sessionTypes = mksConfig.sessionTypes;
        var hasPersistence = (sessionTypes && arrayIncludes(sessionTypes, "persistent-license"));
        var sessionType = hasPersistence &&
            sessionStorage &&
            keySystemOptions.persistentLicense ?
            "persistent-license" : "temporary";
        log.debug("eme: create a new " + sessionType + " session");
        var session = sessionsStore.createSession(initData, initDataType, sessionType);
        // Re-check for Dumb typescript
        if (!hasPersistence || !sessionStorage || !keySystemOptions.persistentLicense) {
            if (false) {
                assert(sessionType === "temporary");
            }
            return observableOf({
                type: "created-session",
                value: { mediaKeySession: session, sessionType: sessionType },
            });
        }
        if (false) {
            assert(sessionType === "persistent-license");
        }
        var storedEntry = sessionStorage.get(initData, initDataType);
        if (!storedEntry) {
            return observableOf({
                type: "created-session",
                value: { mediaKeySession: session, sessionType: sessionType },
            });
        }
        /**
         * Helper function to close and restart the current persistent session
         * considered, and re-create it from scratch.
         * @returns {Observable}
         */
        var recreatePersistentSession = function () {
            log.info("eme: removing previous persistent session.");
            if (sessionStorage.get(initData, initDataType) !== null) {
                sessionStorage.delete(initData, initDataType);
            }
            return sessionsStore.deleteAndCloseSession(session)
                .pipe(map(function () {
                var newSession = sessionsStore.createSession(initData, initDataType, sessionType);
                return {
                    type: "created-session",
                    value: { mediaKeySession: newSession, sessionType: sessionType },
                };
            }));
        };
        return loadPersistentSession(storedEntry.sessionId, session).pipe(mergeMap(function (hasLoadedSession) {
            if (!hasLoadedSession) {
                log.warn("eme: no data stored for the loaded session");
                sessionStorage.delete(initData, initDataType);
                return observableOf({
                    type: "created-session",
                    value: { mediaKeySession: session, sessionType: sessionType },
                });
            }
            if (hasLoadedSession && isSessionUsable(session)) {
                sessionStorage.add(initData, initDataType, session);
                log.info("eme: succeeded to load persistent session.");
                return observableOf({
                    type: "loaded-persistent-session",
                    value: { mediaKeySession: session, sessionType: sessionType },
                });
            }
            // Unusable persistent session: recreate a new session from scratch.
            log.warn("eme: previous persistent session not usable anymore.");
            return recreatePersistentSession();
        }), catchError(function () {
            log.warn("eme: unable to load persistent session.");
            return recreatePersistentSession();
        }));
    });
}