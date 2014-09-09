/*
Copyright 2014 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';

var forAllVideoTracksOnStream = function(s, f) {
    var tracks = s.getVideoTracks();
    for (var i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
}

var forAllAudioTracksOnStream = function(s, f) {
    var tracks = s.getAudioTracks();
    for (var i = 0; i < tracks.length; i++) {
        f(tracks[i]);
    }
}

var forAllTracksOnStream = function(s, f) {
    forAllVideoTracksOnStream(s, f);
    forAllAudioTracksOnStream(s, f);
}

navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
window.RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection; // but not mozRTCPeerConnection because its interface is not compatible
window.RTCSessionDescription = window.RTCSessionDescription || window.webkitRTCSessionDescription || window.mozRTCSessionDescription;
window.RTCIceCandidate = window.RTCIceCandidate || window.webkitRTCIceCandidate || window.mozRTCIceCandidate;

var createPeerConnection = function() {
    var stunServer = 'stun:stun.l.google.com:19302';
    if (window.mozRTCPeerConnection) {
        return new window.mozRTCPeerConnection({'url': stunServer});
    } else {
        return new window.RTCPeerConnection({"iceServers":[{"urls":"stun:stun.l.google.com:19302"}]});
    }
}

angular.module('MatrixCall', [])
.factory('MatrixCall', ['matrixService', 'matrixPhoneService', '$rootScope', function MatrixCallFactory(matrixService, matrixPhoneService, $rootScope) {
    var MatrixCall = function(room_id) {
        this.room_id = room_id;
        this.call_id = "c" + new Date().getTime();
        this.state = 'fledgling';
        this.didConnect = false;
    }

    MatrixCall.prototype.placeCall = function(config) {
        self = this;
        matrixPhoneService.callPlaced(this);
        navigator.getUserMedia({audio: config.audio, video: config.video}, function(s) { self.gotUserMediaForInvite(s); }, function(e) { self.getUserMediaFailed(e); });
        this.state = 'wait_local_media';
        this.direction = 'outbound';
        this.config = config;
    };

    MatrixCall.prototype.initWithInvite = function(msg) {
        this.msg = msg;
        this.peerConn = createPeerConnection();
        self= this;
        this.peerConn.oniceconnectionstatechange = function() { self.onIceConnectionStateChanged(); };
        this.peerConn.onicecandidate = function(c) { self.gotLocalIceCandidate(c); };
        this.peerConn.onsignalingstatechange = function() { self.onSignallingStateChanged(); };
        this.peerConn.onaddstream = function(s) { self.onAddStream(s); };
        this.peerConn.setRemoteDescription(new RTCSessionDescription(this.msg.offer), self.onSetRemoteDescriptionSuccess, self.onSetRemoteDescriptionError);
        this.state = 'ringing';
        this.direction = 'inbound';
    };

    MatrixCall.prototype.answer = function() {
        console.trace("Answering call "+this.call_id);
        self = this;
        navigator.getUserMedia({audio: true, video: false}, function(s) { self.gotUserMediaForAnswer(s); }, function(e) { self.getUserMediaFailed(e); });
        this.state = 'wait_local_media';
    };

    MatrixCall.prototype.stopAllMedia = function() {
        if (this.localAVStream) {
            forAllTracksOnStream(this.localAVStream, function(t) {
                if (t.stop) t.stop();
            });
        }
        if (this.remoteAVStream) {
            forAllTracksOnStream(this.remoteAVStream, function(t) {
                if (t.stop) t.stop();
            });
        }
    };

    MatrixCall.prototype.hangup = function() {
        console.trace("Ending call "+this.call_id);

        this.stopAllMedia();
        if (this.peerConn) this.peerConn.close();

        this.hangupParty = 'local';

        var content = {
            version: 0,
            call_id: this.call_id,
        };
        matrixService.sendEvent(this.room_id, 'm.call.hangup', undefined, content).then(this.messageSent, this.messageSendFailed);
        this.state = 'ended';
        self.onHangup();
    };

    MatrixCall.prototype.gotUserMediaForInvite = function(stream) {
        if (!$rootScope.currentCall || $rootScope.currentCall.state == 'ended') return;

        this.localAVStream = stream;
        var audioTracks = stream.getAudioTracks();
        for (var i = 0; i < audioTracks.length; i++) {
            audioTracks[i].enabled = true;
        }
        this.peerConn = createPeerConnection();
        self = this;
        this.peerConn.oniceconnectionstatechange = function() { self.onIceConnectionStateChanged(); };
        this.peerConn.onsignalingstatechange = function() { self.onSignallingStateChanged(); };
        this.peerConn.onicecandidate = function(c) { self.gotLocalIceCandidate(c); };
        this.peerConn.onaddstream = function(s) { self.onAddStream(s); };
        this.peerConn.addStream(stream);
        this.peerConn.createOffer(function(d) {
            self.gotLocalOffer(d);
        }, function(e) {
            self.getLocalOfferFailed(e);
        });
        $rootScope.$apply(function() {
            self.state = 'create_offer';
        });
    };

    MatrixCall.prototype.gotUserMediaForAnswer = function(stream) {
        if (!$rootScope.currentCall || $rootScope.currentCall.state == 'ended') return;

        this.localAVStream = stream;
        var audioTracks = stream.getAudioTracks();
        for (var i = 0; i < audioTracks.length; i++) {
            audioTracks[i].enabled = true;
        }
        this.peerConn.addStream(stream);
        self = this;
        var constraints = {
            'mandatory': {
                'OfferToReceiveAudio': true,
                'OfferToReceiveVideo': false
            },
        };
        this.peerConn.createAnswer(function(d) { self.createdAnswer(d); }, function(e) {}, constraints);
        $rootScope.$apply(function() {
            self.state = 'create_answer';
        });
    };

    MatrixCall.prototype.gotLocalIceCandidate = function(event) {
        console.trace(event);
        if (event.candidate) {
            var content = {
                version: 0,
                call_id: this.call_id,
                candidate: event.candidate
            };
            matrixService.sendEvent(this.room_id, 'm.call.candidate', undefined, content).then(this.messageSent, this.messageSendFailed);
        }
    }

    MatrixCall.prototype.gotRemoteIceCandidate = function(cand) {
        console.trace("Got ICE candidate from remote: "+cand);
        var candidateObject = new RTCIceCandidate({
            sdpMLineIndex: cand.label,
            candidate: cand.candidate
        });
        this.peerConn.addIceCandidate(candidateObject, function() {}, function(e) {});
    };

    MatrixCall.prototype.receivedAnswer = function(msg) {
        this.peerConn.setRemoteDescription(new RTCSessionDescription(msg.answer), self.onSetRemoteDescriptionSuccess, self.onSetRemoteDescriptionError);
        this.state = 'connecting';
    };

    MatrixCall.prototype.gotLocalOffer = function(description) {
        console.trace("Created offer: "+description);
        this.peerConn.setLocalDescription(description);

        var content = {
            version: 0,
            call_id: this.call_id,
            offer: description
        };
        matrixService.sendEvent(this.room_id, 'm.call.invite', undefined, content).then(this.messageSent, this.messageSendFailed);

        self = this;
        $rootScope.$apply(function() {
            self.state = 'invite_sent';
        });
    };

    MatrixCall.prototype.createdAnswer = function(description) {
        console.trace("Created answer: "+description);
        this.peerConn.setLocalDescription(description);
        var content = {
            version: 0,
            call_id: this.call_id,
            answer: description
        };
        matrixService.sendEvent(this.room_id, 'm.call.answer', undefined, content).then(this.messageSent, this.messageSendFailed);
        self = this;
        $rootScope.$apply(function() {
            self.state = 'connecting';
        });
    };

    MatrixCall.prototype.messageSent = function() {
    };
    
    MatrixCall.prototype.messageSendFailed = function(error) {
    };

    MatrixCall.prototype.getLocalOfferFailed = function(error) {
        this.onError("Failed to start audio for call!");
    };

    MatrixCall.prototype.getUserMediaFailed = function() {
        this.onError("Couldn't start capturing audio! Is your microphone set up?");
        this.hangup();
    };

    MatrixCall.prototype.onIceConnectionStateChanged = function() {
        if (this.state == 'ended') return; // because ICE can still complete as we're ending the call
        console.trace("Ice connection state changed to: "+this.peerConn.iceConnectionState);
        // ideally we'd consider the call to be connected when we get media but chrome doesn't implement nay of the 'onstarted' events yet
        if (this.peerConn.iceConnectionState == 'completed' || this.peerConn.iceConnectionState == 'connected') {
            self = this;
            $rootScope.$apply(function() {
                self.state = 'connected';
                self.didConnect = true;
            });
        }
    };

    MatrixCall.prototype.onSignallingStateChanged = function() {
        console.trace("Signalling state changed to: "+this.peerConn.signalingState);
    };

    MatrixCall.prototype.onSetRemoteDescriptionSuccess = function() {
        console.trace("Set remote description");
    };
    
    MatrixCall.prototype.onSetRemoteDescriptionError = function(e) {
        console.trace("Failed to set remote description"+e);
    };

    MatrixCall.prototype.onAddStream = function(event) {
        console.trace("Stream added"+event);

        var s = event.stream;

        this.remoteAVStream = s;

        var self = this;
        forAllTracksOnStream(s, function(t) {
            // not currently implemented in chrome
            t.onstarted = self.onRemoteStreamTrackStarted;
        });

        event.stream.onended = function(e) { self.onRemoteStreamEnded(e); }; 
        // not currently implemented in chrome
        event.stream.onstarted = function(e) { self.onRemoteStreamStarted(e); };
        var player = new Audio();
        player.src = URL.createObjectURL(s);
        player.play();
    };

    MatrixCall.prototype.onRemoteStreamStarted = function(event) {
        self = this;
        $rootScope.$apply(function() {
            self.state = 'connected';
        });
    };

    MatrixCall.prototype.onRemoteStreamEnded = function(event) {
        self = this;
        $rootScope.$apply(function() {
            self.state = 'ended';
            this.hangupParty = 'remote';
            self.stopAllMedia();
            this.peerConn.close();
            self.onHangup();
        });
    };

    MatrixCall.prototype.onRemoteStreamTrackStarted = function(event) {
        self = this;
        $rootScope.$apply(function() {
            self.state = 'connected';
        });
    };

    MatrixCall.prototype.onHangupReceived = function() {
        this.state = 'ended';
        this.hangupParty = 'remote';
        this.stopAllMedia();
        this.peerConn.close();
        this.onHangup();
    };

    return MatrixCall;
}]);
