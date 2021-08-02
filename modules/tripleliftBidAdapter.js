import { BANNER, VIDEO, NATIVE } from '../src/mediaTypes.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import * as utils from '../src/utils.js';
import { config } from '../src/config.js';

const GVLID = 28;
const BIDDER_CODE = 'triplelift';
const STR_ENDPOINT = 'https://tlx.3lift.com/header/auction?';
const STR_ENDPOINT_NATIVE = 'https://tlx.3lift.com/header_native/auction?';
let gdprApplies = true;
let consentString = null;
// TODO null or []?
let standardUnits = null;
let nativeUnits = null;

export const tripleliftAdapterSpec = {
  gvlid: GVLID,
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],
  isBidRequestValid: function (bid) {
    return typeof bid.params.inventoryCode !== 'undefined';
  },

  buildRequests: function (bidRequests, bidderRequest) {
    console.log('bidRequests', bidRequests);
    let endpoints = {
      standard: STR_ENDPOINT,
      native: STR_ENDPOINT_NATIVE
    };
    let data = _filterData(_buildPostBody(bidRequests));

    for (const prop in endpoints) {
      endpoints[prop] = utils.tryAppendQueryString(endpoints[prop], 'lib', 'prebid');
      endpoints[prop] = utils.tryAppendQueryString(endpoints[prop], 'v', '$prebid.version$');

      if (bidderRequest && bidderRequest.refererInfo) {
        let referrer = bidderRequest.refererInfo.referer;
        endpoints[prop] = utils.tryAppendQueryString(endpoints[prop], 'referrer', referrer);
      }

      if (bidderRequest && bidderRequest.timeout) {
        endpoints[prop] = utils.tryAppendQueryString(
          endpoints[prop],
          'tmax',
          bidderRequest.timeout
        );
      }

      if (bidderRequest && bidderRequest.gdprConsent) {
        if (typeof bidderRequest.gdprConsent.gdprApplies !== 'undefined') {
          gdprApplies = bidderRequest.gdprConsent.gdprApplies;
          endpoints[prop] = utils.tryAppendQueryString(
            endpoints[prop],
            'gdpr',
            gdprApplies.toString()
          );
        }
        if (typeof bidderRequest.gdprConsent.consentString !== 'undefined') {
          consentString = bidderRequest.gdprConsent.consentString;
          endpoints[prop] = utils.tryAppendQueryString(endpoints[prop], 'cmp_cs', consentString);
        }
      }

      if (bidderRequest && bidderRequest.uspConsent) {
        endpoints[prop] = utils.tryAppendQueryString(
          endpoints[prop],
          'us_privacy',
          bidderRequest.uspConsent
        );
      }

      if (config.getConfig('coppa') === true) {
        endpoints[prop] = utils.tryAppendQueryString(endpoints[prop], 'coppa', true);
      }

      if (endpoints[prop].lastIndexOf('&') === endpoints[prop].length - 1) {
        endpoints[prop] = endpoints[prop].substring(0, endpoints[prop].length - 1);
      }
      utils.logMessage(`${prop} request built: ${endpoints[prop]}`);
    }

    // Endpoint is not called if data is not available for it
    return Object.keys(data).map(mediaType => {
      return {
        method: 'POST',
        url: endpoints[mediaType],
        data: data[mediaType],
        bidderRequest
      };
    });
  },

  interpretResponse: function (serverResponse, request) {
    let bids = serverResponse.body.bids || [];
    return bids.map(function (bid) {
      return _buildResponseObject(request, bid);
    });
  },

  getUserSyncs: function (syncOptions, responses, gdprConsent, usPrivacy) {
    let syncType = _getSyncType(syncOptions);
    if (!syncType) return;

    let syncEndpoint = 'https://eb2.3lift.com/sync?';

    if (syncType === 'image') {
      syncEndpoint = utils.tryAppendQueryString(syncEndpoint, 'px', 1);
      syncEndpoint = utils.tryAppendQueryString(syncEndpoint, 'src', 'prebid');
    }

    if (consentString !== null) {
      syncEndpoint = utils.tryAppendQueryString(syncEndpoint, 'gdpr', gdprApplies);
      syncEndpoint = utils.tryAppendQueryString(syncEndpoint, 'cmp_cs', consentString);
    }

    if (usPrivacy) {
      syncEndpoint = utils.tryAppendQueryString(syncEndpoint, 'us_privacy', usPrivacy);
    }

    return [
      {
        type: syncType,
        url: syncEndpoint
      }
    ];
  }
};

function _getSyncType(syncOptions) {
  if (!syncOptions) return;
  if (syncOptions.iframeEnabled) return 'iframe';
  if (syncOptions.pixelEnabled) return 'image';
}

function _buildPostBody(bidRequests) {
  standardUnits = bidRequests.filter(bid => !bid.mediaTypes.native);
  nativeUnits = bidRequests.filter(bid => bid.mediaTypes.native);

  let standard = {};
  let native = {};
  let { schain } = bidRequests[0];
  let globalFpd = _getGlobalFpd();

  // Returns empty array if no units; which will later be filtered out by _filterData
  standard.imp = standardUnits.map((bidRequest, index) => {
    let imp = {
      id: index,
      tagid: bidRequest.params.inventoryCode,
      floor: _getFloor(bidRequest)
    };
    // remove the else to support multi-imp
    if (_isInstreamBidRequest(bidRequest)) {
      imp.video = _getORTBVideo(bidRequest);
    } else if (bidRequest.mediaTypes.banner) {
      imp.banner = { format: _sizes(bidRequest.sizes) };
    }
    if (!utils.isEmpty(bidRequest.ortb2Imp)) {
      imp.fpd = _getAdUnitFpd(bidRequest.ortb2Imp);
    }
    return imp;
  });

  // Returns empty array if no units; which will later be filtered out by _filterData
  native.imp = nativeUnits.map((bidRequest, index) => {
    // TODO: this line isnt necessary
    if (bidRequest.nativeParams.image.sizes) {
      bidRequest.nativeParams.image.sizes = _sizes(bidRequest.nativeParams.image.sizes);
    }

    let imp = {
      id: index,
      tagid: bidRequest.params.inventoryCode,
      floor: _getFloor(bidRequest),
      native: bidRequest.nativeParams,
      // TODO: Where should sizes come from? Can this always be [1, 1]? TLX requies sizes to be located here in request
      sizes: _sizes([[1, 1]])
    };

    if (!utils.isEmpty(bidRequest.ortb2Imp)) {
      imp.fpd = _getAdUnitFpd(bidRequest.ortb2Imp);
    }

    return imp;
  });

  let eids = [
    ...getUnifiedIdEids([bidRequests[0]]),
    ...getIdentityLinkEids([bidRequests[0]]),
    ...getCriteoEids([bidRequests[0]]),
    ...getPubCommonEids([bidRequests[0]])
  ];

  if (eids.length > 0) {
    standard.user = {
      ext: { eids }
    };

    native.user = {
      ext: { eids }
    };
  }

  let ext = _getExt(schain, globalFpd);

  if (!utils.isEmpty(ext)) {
    standard.ext = ext;
    native.ext = ext;
  }
  return {
    standard: standard,
    native: native
  };
}

function _getMediaType(bid) {
  if (_isInstreamBidRequest(bid)) return 'video';
  if (_isNativeBidRequest(bid)) return 'native';
  return 'banner';
}

function _isNativeBidRequest(bidRequest) {
  return bidRequest.mediaTypes.native && bidRequest.nativeParams ? true : false;
}

function _isInstreamBidRequest(bidRequest) {
  if (!bidRequest.mediaTypes.video) return false;
  if (!bidRequest.mediaTypes.video.context) return false;
  if (bidRequest.mediaTypes.video.context.toLowerCase() === 'instream') {
    return true;
  } else {
    return false;
  }
}

function _getORTBVideo(bidRequest) {
  // give precedent to mediaTypes.video
  let video = { ...bidRequest.params.video, ...bidRequest.mediaTypes.video };
  if (!video.w) video.w = video.playerSize[0][0];
  if (!video.h) video.h = video.playerSize[0][1];
  if (video.context === 'instream') video.placement = 1;
  // clean up oRTB object
  delete video.playerSize;
  return video;
}

function _getFloor(bid) {
  let floor = null;
  if (typeof bid.getFloor === 'function') {
    const floorInfo = bid.getFloor({
      currency: 'USD',
      mediaType: _getMediaType(bid),
      size: '*'
    });
    if (
      typeof floorInfo === 'object' &&
      floorInfo.currency === 'USD' &&
      !isNaN(parseFloat(floorInfo.floor))
    ) {
      floor = parseFloat(floorInfo.floor);
    }
  }
  return floor !== null ? floor : bid.params.floor;
}

function _getGlobalFpd() {
  const fpd = {};
  const context = {};
  const user = {};
  const ortbData = config.getLegacyFpd(config.getConfig('ortb2')) || {};

  const fpdContext = Object.assign({}, ortbData.context);
  const fpdUser = Object.assign({}, ortbData.user);

  _addEntries(context, fpdContext);
  _addEntries(user, fpdUser);

  if (!utils.isEmpty(context)) {
    fpd.context = context;
  }
  if (!utils.isEmpty(user)) {
    fpd.user = user;
  }
  return fpd;
}

function _getAdUnitFpd(adUnitFpd) {
  const fpd = {};
  const context = {};

  _addEntries(context, adUnitFpd.ext);

  if (!utils.isEmpty(context)) {
    fpd.context = context;
  }

  return fpd;
}

function _addEntries(target, source) {
  if (!utils.isEmpty(source)) {
    Object.keys(source).forEach(key => {
      if (source[key] != null) {
        target[key] = source[key];
      }
    });
  }
}

function _getExt(schain, fpd) {
  let ext = {};
  if (!utils.isEmpty(schain)) {
    ext.schain = { ...schain };
  }
  if (!utils.isEmpty(fpd)) {
    ext.fpd = { ...fpd };
  }
  return ext;
}

function getUnifiedIdEids(bidRequest) {
  return getEids(bidRequest, 'tdid', 'adserver.org', 'TDID');
}

function getIdentityLinkEids(bidRequest) {
  return getEids(bidRequest, 'idl_env', 'liveramp.com', 'idl');
}

function getCriteoEids(bidRequest) {
  return getEids(bidRequest, 'criteoId', 'criteo.com', 'criteoId');
}

function getPubCommonEids(bidRequest) {
  return getEids(bidRequest, 'pubcid', 'pubcid.org', 'pubcid');
}

function getEids(bidRequest, type, source, rtiPartner) {
  return bidRequest
    .map(getUserId(type)) // bids -> userIds of a certain type
    .filter(x => !!x) // filter out null userIds
    .map(formatEid(source, rtiPartner)); // userIds -> eid objects
}

function getUserId(type) {
  return bid => bid && bid.userId && bid.userId[type];
}

function formatEid(source, rtiPartner) {
  return id => ({
    source,
    uids: [
      {
        id,
        ext: { rtiPartner }
      }
    ]
  });
}

function _sizes(sizeArray) {
  let sizes = sizeArray.filter(_isValidSize);
  return sizes.map(function (size) {
    return {
      w: size[0],
      h: size[1]
    };
  });
}

function _isValidSize(size) {
  return size.length === 2 && typeof size[0] === 'number' && typeof size[1] === 'number';
}

// TODO: Possibly use ternaries to remove some of the excess here
function _buildResponseObject(request, bid) {
  if (bid.native_ad) {
    console.log('nativeUnits - bid', nativeUnits, bid);

    let bidResponse = {};
    let width = bid.width || 1;
    let height = bid.height || 1;
    let dealId = bid.deal_id || '';
    let creativeId = bid.crid || '';
    let body = bid.native_ad.body || '';
    let icon = bid.native_ad.icon || '';
    let image = bid.native_ad.image || '';
    let cta = bid.native_ad.cta || '';
    let adChoices = bid.native_ad.adChoices || '';

    // TODO: What is this and is it necessary?
    if (bid.native_ad.image.sizes) {
      bid.native_ad.image.sizes = _sizes(bid.native_ad.image.sizes);
    }
    if (bid.cpm != 0) {
      bidResponse = {
        requestId: nativeUnits[bid.imp_id].bidId,
        cpm: bid.cpm,
        width: width,
        height: height,
        native: {
          image: image,
          title: bid.native_ad.title,
          clickUrl: bid.native_ad.clickUrl,
          sponsoredBy: bid.native_ad.sponsoredBy,
          impressionTrackers: bid.native_ad.impTrackers,
          clickTrackers: bid.native_ad.viewTrackers,
          body: body,
          icon: icon,
          cta: cta,
          adChoices: adChoices
        },
        netRevenue: true,
        dealId: dealId,
        creativeId: creativeId,
        currency: 'USD',
        ttl: 33,
        mediaType: 'native',
        meta: {
          mediaType: 'native'
        }
      };
    }
    console.log('bidResponse', bidResponse);
    return bidResponse;
  }

  console.log('standardUnits - bid', standardUnits, bid);
  let bidResponse = {};
  let width = bid.width || 1;
  let height = bid.height || 1;
  let dealId = bid.deal_id || '';
  let creativeId = bid.crid || '';
  let breq = standardUnits[bid.imp_id];

  if (bid.cpm != 0 && bid.ad) {
    bidResponse = {
      requestId: breq.bidId,
      cpm: bid.cpm,
      width: width,
      height: height,
      netRevenue: true,
      ad: bid.ad,
      creativeId: creativeId,
      dealId: dealId,
      currency: 'USD',
      ttl: 300,
      tl_source: bid.tl_source,
      meta: {}
    };

    if (_isInstreamBidRequest(breq)) {
      bidResponse.vastXml = bid.ad;
      bidResponse.mediaType = 'video';
    }

    if (bid.advertiser_name) {
      bidResponse.meta.advertiserName = bid.advertiser_name;
    }

    if (bid.adomain && bid.adomain.length) {
      bidResponse.meta.advertiserDomains = bid.adomain;
    }

    if (bid.tl_source && bid.tl_source == 'hdx') {
      bidResponse.meta.mediaType = 'banner';
    }

    if (bid.tl_source && bid.tl_source == 'tlx') {
      bidResponse.meta.mediaType = 'native';
    }
  }
  console.log('bidResponse', bidResponse);
  return bidResponse;
}

function _filterData(obj) {
  let result = {};

  for (const key in obj) {
    if (!utils.isEmpty(obj[key].imp)) {
      result[key] = obj[key];
    }
  }

  return result;
}

registerBidder(tripleliftAdapterSpec);
