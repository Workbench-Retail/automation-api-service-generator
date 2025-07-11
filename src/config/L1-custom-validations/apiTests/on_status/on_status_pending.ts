import _ from "lodash";
import { RedisService } from "ondc-automation-cache-lib";
import {
  areTimestampsLessThanOrEqualTo,
  payment_status,
  compareTimeRanges,
  compareObjects,
  compareQuoteObjects,
  sumQuoteBreakUp,
  compareCoordinates,
  isoDurToSec,
} from "../../utils/helper";
import { FLOW } from "../../utils/enums";
import constants, {
  ApiSequence,
  PAYMENT_STATUS,
} from "../../utils/constants";
import { contextChecker } from "../../utils/contextUtils";

const ERROR_CODES = {
  INVALID_RESPONSE: 20006,
  INVALID_ORDER_STATE: 20007,
  OUT_OF_SEQUENCE: 20008,
  TIMEOUT: 20009,
  INVALID_CANCELLATION_TERMS: 22505,
  INTERNAL_ERROR: 23001,
  ORDER_VALIDATION_FAILURE: 23002,
};

const TTL_IN_SECONDS = Number(process.env.TTL_IN_SECONDS) || 3600;

const addError = (description: any, code: any) => ({
  valid: false,
  code,
  description,
});

async function validateOrder(
  order: any,
  transaction_id: any,
  state: any,
  result: any
) {
  const cnfrmOrdrId = await RedisService.getKey(
    `${transaction_id}_cnfrmOrdrId`
  );
  if (cnfrmOrdrId && order.id !== cnfrmOrdrId) {
    result.push(
      addError(
        `Order id in /${constants.CONFIRM} and /${constants.ON_STATUS}_${state} do not match`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  if (order.cancellation_terms && order.cancellation_terms.length > 0) {
    result.push(
      addError(
        `'cancellation_terms' in /message/order should not be provided as those are not enabled yet`,
        ERROR_CODES.INVALID_CANCELLATION_TERMS
      )
    );
  }
  if (order.state !== "Created" && order.state !== "Accepted") {
    result.push(
      addError(
        `Order state should be 'Created' or 'Accepted' in /${constants.ON_STATUS}_${state}. Current state: ${order.state}`,
        ERROR_CODES.INVALID_ORDER_STATE
      )
    );
  }
  const providerIdRaw = await RedisService.getKey(
    `${transaction_id}_providerId`
  );
  const providerId = providerIdRaw ? JSON.parse(providerIdRaw) : null;
  if (providerId && order.provider?.id !== providerId) {
    result.push(
      addError(
        `Provider Id mismatches in /${constants.ON_SEARCH} and /${constants.ON_STATUS}_${state}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  const providerLocRaw = await RedisService.getKey(
    `${transaction_id}_providerLoc`
  );
  const providerLoc = providerLocRaw ? JSON.parse(providerLocRaw) : null;
  if (providerLoc && order.provider?.locations?.[0]?.id !== providerLoc) {
    result.push(
      addError(
        `provider.locations[0].id mismatches in /${constants.ON_SEARCH} and /${constants.ON_STATUS}_${state}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  const provider = order?.provider || {};
  if (Array.isArray(provider.creds) && provider.creds.length > 0) {
    const currentCred = provider.creds[0];
    const { id, descriptor } = currentCred;

    if (id && descriptor?.code && descriptor?.short_desc) {
      const stored = await RedisService.getKey(
        `${transaction_id}_${constants.ON_SEARCH}_credsDescriptor`
      );
      const storedCreds = stored ? JSON.parse(stored) : [];

      const isMatchFound = storedCreds.some(
        (storedCred: any) =>
          storedCred.id === id &&
          storedCred.descriptor?.code === descriptor.code &&
          storedCred.descriptor?.short_desc === descriptor.short_desc
      );

      if (storedCreds.length > 0 && !isMatchFound) {
        addError(
          23003,
          `Order validation failure: Credential (id + descriptor) in /${constants.ON_CONFIRM} does not match /${constants.ON_SEARCH}`
        );
      }
    }
  }
  await RedisService.setKey(
    `${transaction_id}_orderState`,
    JSON.stringify(order.state),
    TTL_IN_SECONDS
  );
}

async function validateFulfillments(
  order: any,
  transaction_id: any,
  state: any,
  fulfillmentsItemsSet: any,
  result: any
) {
  try {
    const [
      buyerGpsRaw,
      buyerAddrRaw,
      fulfillmentTatObjRaw,
      onSelectFulfillmentsRaw,
      providerAddrRaw,
    ] = await Promise.all(
      [
        RedisService.getKey(`${transaction_id}_buyerGps`),
        RedisService.getKey(`${transaction_id}_buyerAddr`),

        RedisService.getKey(`${transaction_id}_fulfillment_tat_obj`),
        RedisService.getKey(`${transaction_id}_onSelectFulfillments`),
        RedisService.getKey(`${transaction_id}_providerAddr`),
      ].map(async (promise) => {
        try {
          return await promise;
        } catch {
          return null;
        }
      })
    );

    const buyerGps = buyerGpsRaw ? JSON.parse(buyerGpsRaw) : null;
    const buyerAddr = buyerAddrRaw ? JSON.parse(buyerAddrRaw) : null;
    const fulfillmentTatObj = fulfillmentTatObjRaw
      ? JSON.parse(fulfillmentTatObjRaw)
      : null;
    const onSelectFulfillments = onSelectFulfillmentsRaw
      ? JSON.parse(onSelectFulfillmentsRaw)
      : null;
    const providerAddr = providerAddrRaw ? JSON.parse(providerAddrRaw) : null;
    const fulfillmentIds = new Set();
    for (const ff of order?.fulfillments || []) {
      if (!ff?.id) {
        result.push(
          addError(
            `Fulfillment Id must be present`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
        continue;
      }
      if (fulfillmentIds.has(ff.id)) {
        result.push(
          addError(
            `Duplicate fulfillment ID ${ff.id} in /${constants.ON_STATUS}_${state}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      fulfillmentIds.add(ff.id);
    }
    const flow = (await RedisService.getKey("flow")) || "2";
    const orderState =
      (await RedisService.getKey(`${transaction_id}_orderState`)) ||
      '"Accepted"';
    const parsedOrderState = JSON.parse(orderState);
    for (const ff of order?.fulfillments || []) {
      const ffId = ff?.id || "unknown";
      if (!ff?.type) {
        result.push(
          addError(
            `Fulfillment type does not exist in /${constants.ON_STATUS}_${state} for fulfillment ID ${ffId}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else {
        const validTypes = ["Delivery", "Self-Pickup", "Return", "Cancel"];
        if (!validTypes.includes(ff.type)) {
          result.push(
            addError(
              `Invalid fulfillment type ${
                ff.type
              } for ID ${ffId}; must be one of ${validTypes.join(", ")}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
      if (!ff?.["@ondc/org/TAT"]) {
        if (ff?.type === "Delivery") {
          result.push(
            addError(
              `'TAT' must be provided in message/order/fulfillments[${ffId}]`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      } else if (
        fulfillmentTatObj &&
        fulfillmentTatObj[ffId] !== isoDurToSec(ff["@ondc/org/TAT"])
      ) {
        result.push(
          addError(
            `TAT Mismatch between /${
              constants.ON_STATUS
            }_${state} i.e ${isoDurToSec(ff["@ondc/org/TAT"])} seconds & /${
              constants.ON_CONFIRM
            } i.e ${fulfillmentTatObj[ffId]} seconds for ID ${ffId}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (ff?.type !== "Cancel") {
        if (ff?.tracking === undefined || ff?.tracking === null) {
          result.push(
            addError(
              `Tracking key must be explicitly true or false for fulfillment ID ${ffId}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else if (typeof ff.tracking !== "boolean") {
          result.push(
            addError(
              `Tracking must be a boolean (true or false) for fulfillment ID ${ffId}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else {
          try {
            const ffTrackingRaw = await RedisService.getKey(
              `${transaction_id}_${ffId}_tracking`
            );
            const ffTracking = ffTrackingRaw ? JSON.parse(ffTrackingRaw) : null;
            if (ffTracking !== null && ffTracking !== ff.tracking) {
              result.push(
                addError(
                  `Fulfillment Tracking mismatch with /${constants.ON_CONFIRM} for ID ${ffId} (expected ${ffTracking}, got ${ff.tracking})`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            }
          } catch {
            result.push(
              addError(
                `Error validating tracking for fulfillment ID ${ffId}`,
                ERROR_CODES.INTERNAL_ERROR
              )
            );
          }
        }
      } else if (ff?.tracking !== undefined) {
        result.push(
          addError(
            `Tracking key must not be present for Cancel fulfillment ID ${ffId}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      const ffDesc = ff?.state?.descriptor;
      if (ff.type === "Delivery") {
        if (!ffDesc?.code || ffDesc.code !== "Pending") {
          result.push(
            addError(
              `Fulfillment state should be 'Pending' for ID ${ffId} in /${constants.ON_STATUS}_${state}`,
              ERROR_CODES.INVALID_ORDER_STATE
            )
          );
        } else if (
          parsedOrderState !== "Created" &&
          parsedOrderState !== "Accepted"
        ) {
          result.push(
            addError(
              `Fulfillment state 'Pending' is incompatible with order state ${parsedOrderState} for ID ${ffId}`,
              ERROR_CODES.INVALID_ORDER_STATE
            )
          );
        }
      }
      if (ffDesc?.short_desc && typeof ffDesc.short_desc !== "string") {
        result.push(
          addError(
            `fulfillments[${ffId}].state.descriptor.short_desc must be a string`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (ff.type === "Delivery") {
        if (!ff?.start || !ff?.end) {
          result.push(
            addError(
              `fulfillments[${ffId}] start and end locations are mandatory`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else {
          const gpsPattern = /^-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$/;
          if (!ff?.start?.location?.gps) {
            result.push(
              addError(
                `fulfillments[${ffId}].start.location.gps is required`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else if (!gpsPattern.test(ff.start.location.gps)) {
            result.push(
              addError(
                `fulfillments[${ffId}].start.location.gps must be in 'latitude,longitude' format`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else if (
            providerAddr &&
            !compareCoordinates(
              ff.start.location.gps,
              providerAddr?.location?.gps
            )
          ) {
            result.push(
              addError(
                `store gps location /fulfillments[${ffId}]/start/location/gps can't change`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
          if (!ff?.end?.location?.gps) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.location.gps is required`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else if (!gpsPattern.test(ff.end.location.gps)) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.location.gps must be in 'latitude,longitude' format`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else if (buyerGps && !_.isEqual(ff.end.location.gps, buyerGps)) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.location.gps does not match gps in /${constants.SELECT}`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
          if (!ff?.start?.location?.address) {
            result.push(
              addError(
                `fulfillments[${ffId}].start.location.address is required`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else {
            const requiredFields = ["locality", "area_code", "city", "state"];
            for (const field of requiredFields) {
              if (!ff?.start?.location?.address?.[field]) {
                result.push(
                  addError(
                    `fulfillments[${ffId}].start.location.address.${field} is required`,
                    ERROR_CODES.INVALID_RESPONSE
                  )
                );
              }
            }
            if (
              providerAddr &&
              !_.isEqual(
                ff.start.location.address,
                providerAddr.location.address
              )
            ) {
              result.push(
                addError(
                  `fulfillments[${ffId}].start.location.address does not match address in /${constants.ON_SEARCH}`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            }
          }
          if (!ff?.end?.location?.address) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.location.address is required`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else {
            if (!ff?.end?.location?.address?.area_code) {
              result.push(
                addError(
                  `fulfillments[${ffId}].end.location.address.area_code is required`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            } else if (
              buyerAddr &&
              !_.isEqual(ff.end.location.address.area_code, buyerAddr)
            ) {
              result.push(
                addError(
                  `fulfillments[${ffId}].end.location.address.area_code does not match area_code in /${constants.SELECT}`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            }
            if (ff.type === "Delivery") {
              const requiredFields = ["building", "city", "state", "country"];
              for (const field of requiredFields) {
                if (!ff?.end?.location?.address?.[field]) {
                  result.push(
                    addError(
                      `fulfillments[${ffId}].end.location.address.${field} is required for Delivery`,
                      ERROR_CODES.INVALID_RESPONSE
                    )
                  );
                }
              }
            }
          }
        }
      }
      if (ff.type === "Delivery") {
        if (!ff?.start?.contact?.phone) {
          result.push(
            addError(
              `fulfillments[${ffId}].start.contact.phone is required`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else {
          const phonePattern = /^\+?\d{10,15}$/;
          if (!phonePattern.test(ff.start.contact.phone)) {
            result.push(
              addError(
                `fulfillments[${ffId}].start.contact.phone must be a valid phone number`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
        }
      }
      if (ff.type === "Delivery") {
        if (!ff?.end?.contact?.phone) {
        } else {
          const phonePattern = /^\+?\d{10,15}$/;
          if (!phonePattern.test(ff.end.contact.phone)) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.contact.phone must be a valid phone number`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
        }
      }
      if (ff?.type === "Delivery" && ff?.agent) {
        if (
          !ff?.agent?.name ||
          typeof ff.agent.name !== "string" ||
          ff.agent.name.trim() === ""
        ) {
          result.push(
            addError(
              `fulfillments[${ffId}].agent.name must be a non-empty string if agent is provided`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
        if (ff?.agent?.phone) {
          const phonePattern = /^\+?\d{10,15}$/;
          if (!phonePattern.test(ff.agent.phone)) {
            result.push(
              addError(
                `fulfillments[${ffId}].agent.phone must be a valid phone number if provided`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
        }
      }
      if (ff?.start?.time) {
        if (!ff?.start?.time?.timestamp && !ff?.start?.time?.range) {
          result.push(
            addError(
              `fulfillments[${ffId}].start.time must have timestamp or range`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else if (ff?.start?.time?.range) {
          if (!ff?.start?.time?.range?.start || !ff?.start?.time?.range?.end) {
            result.push(
              addError(
                `fulfillments[${ffId}].start.time.range must have start and end timestamps`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else if (
            new Date(ff.start.time.range.end) <=
            new Date(ff.start.time.range.start)
          ) {
            result.push(
              addError(
                `fulfillments[${ffId}].start.time.range.end must be after range.start`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
          if (onSelectFulfillments) {
            const selectFf = onSelectFulfillments.find(
              (f: any) => f.id === ffId
            );
            if (
              selectFf?.start?.time?.range &&
              !_.isEqual(ff.start.time.range, selectFf.start.time.range)
            ) {
              result.push(
                addError(
                  `fulfillments[${ffId}].start.time.range does not match /${constants.ON_SELECT}`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            }
          }
        }
      }
      if (ff?.end?.time) {
        if (!ff?.end?.time?.timestamp && !ff?.end?.time?.range) {
          result.push(
            addError(
              `fulfillments[${ffId}].end.time must have timestamp or range`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else if (ff?.end?.time?.range) {
          if (!ff?.end?.time?.range?.start || !ff?.end?.time?.range?.end) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.time.range must have start and end timestamps`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else if (
            new Date(ff.end.time.range.end) <= new Date(ff.end.time.range.start)
          ) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.time.range.end must be after range.start`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
          if (onSelectFulfillments) {
            const selectFf = onSelectFulfillments.find(
              (f: any) => f.id === ffId
            );
            if (
              selectFf?.end?.time?.range &&
              !_.isEqual(ff.end.time.range, selectFf.end.time.range)
            ) {
              result.push(
                addError(
                  `fulfillments[${ffId}].end.time.range does not match /${constants.ON_SELECT}`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            }
          }
        }
        if (ff?.start?.time?.timestamp && ff?.end?.time?.timestamp) {
          if (
            new Date(ff.end.time.timestamp) <= new Date(ff.start.time.timestamp)
          ) {
            result.push(
              addError(
                `fulfillments[${ffId}].end.time.timestamp must be after start.time.timestamp`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
        }
      }
      if (ff?.type === "Self-Pickup" && flow === "3") {
        if (!ff?.vehicle) {
          result.push(
            addError(
              `fulfillments[${ffId}].vehicle is required for Self-Pickup`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else {
          if (!ff?.vehicle?.category || ff.vehicle.category !== "Kerbside") {
            result.push(
              addError(
                `fulfillments[${ffId}].vehicle.category must be 'Kerbside' for Self-Pickup`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
          if (!ff?.vehicle?.number) {
            result.push(
              addError(
                `fulfillments[${ffId}].vehicle.number is required for Self-Pickup`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
          if (onSelectFulfillments) {
            const selectFf = onSelectFulfillments.find(
              (f: any) => f.id === ffId
            );
            if (selectFf?.vehicle && !_.isEqual(ff.vehicle, selectFf.vehicle)) {
              result.push(
                addError(
                  `fulfillments[${ffId}].vehicle details do not match /${constants.ON_SELECT}`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            }
          }
        }
      } else if (ff?.vehicle && ff.type === "Cancel") {
        result.push(
          addError(
            `fulfillments[${ffId}].vehicle must not be present for Cancel`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (ff?.tags) {
        if (onSelectFulfillments) {
          const selectFf = onSelectFulfillments.find((f: any) => f.id === ffId);
          if (selectFf?.tags && !_.isEqual(ff.tags, selectFf.tags)) {
            result.push(
              addError(
                `fulfillments[${ffId}].tags do not match /${constants.ON_SELECT}`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          }
        }
      }
      if (ff?.rateable !== undefined && typeof ff.rateable !== "boolean") {
        result.push(
          addError(
            `fulfillments[${ffId}].rateable must be a boolean`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (
        ff?.start?.instructions &&
        typeof ff.start.instructions !== "string"
      ) {
        result.push(
          addError(
            `fulfillments[${ffId}].start.instructions must be a string`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (ff?.end?.instructions && typeof ff.end.instructions !== "string") {
        result.push(
          addError(
            `fulfillments[${ffId}].end.instructions must be a string`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (
        (!providerAddr ||
          !_.isEqual(
            ff?.start?.location?.descriptor?.name,
            providerAddr?.location?.descriptor?.name
          )) &&
        ff?.type == "Delivery"
      ) {
        result.push(
          addError(
            `store name /fulfillments[${ffId}]/start/location/descriptor/name can't change`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    }
    try {
      const storedFulfillmentRaw = await RedisService.getKey(
        `${transaction_id}_deliveryFulfillment`
      );
      const storedFulfillment = storedFulfillmentRaw
        ? JSON.parse(storedFulfillmentRaw)
        : null;
      const deliveryFulfillment =
        order?.fulfillments?.filter((f: any) => f?.type === "Delivery") || [];
      if (!storedFulfillment) {
        if (deliveryFulfillment.length > 0) {
          await Promise.all([
            RedisService.setKey(
              `${transaction_id}_deliveryFulfillment`,
              JSON.stringify(deliveryFulfillment[0]),
              TTL_IN_SECONDS
            ),
            RedisService.setKey(
              `${transaction_id}_deliveryFulfillmentAction`,
              JSON.stringify(ApiSequence.ON_STATUS_PENDING),
              TTL_IN_SECONDS
            ),
          ]);
        }
      } else {
        const storedFulfillmentActionRaw = await RedisService.getKey(
          `${transaction_id}_deliveryFulfillmentAction`
        );
        const storedFulfillmentAction = storedFulfillmentActionRaw
          ? JSON.parse(storedFulfillmentActionRaw)
          : null;
        const fulfillmentRangeErrors = compareTimeRanges(
          storedFulfillment,
          storedFulfillmentAction,
          deliveryFulfillment[0],
          ApiSequence.ON_STATUS_PENDING
        );
        if (fulfillmentRangeErrors) {
          fulfillmentRangeErrors.forEach((error: any) => {
            result.push(addError(`${error}`, ERROR_CODES.INVALID_RESPONSE));
          });
        }
      }

      const deliveryFulfillmentReplacementRaw = await RedisService.getKey(
        `${transaction_id}_deliveryObjReplacement`
      );
      const deliveryFulfillmentReplacement = deliveryFulfillmentReplacementRaw
        ? JSON.parse(deliveryFulfillmentReplacementRaw)
        : null;

      deliveryFulfillment.forEach((ff: any) => {
        if (deliveryFulfillmentReplacement) {
          const matchingReplacement = deliveryFulfillmentReplacement.find(
            (replacement: any) => replacement.id === ff.id
          );
          if (matchingReplacement) {
            // Compare and validate the matching replacement
            const fulfillmentErrors = compareObjects(ff, matchingReplacement);
            console.log("fulfillmentErrors", fulfillmentErrors);
            if (fulfillmentErrors) {
              fulfillmentErrors.forEach((error: any) => {
                result.push(addError(`${error}`, ERROR_CODES.INVALID_RESPONSE));
              });
            }
          }
        }
      });
    } catch {
      result.push(
        addError(
          `Error processing delivery fulfillment`,
          ERROR_CODES.INTERNAL_ERROR
        )
      );
    }
    if (["6", "2", "3", "5"].includes(flow)) {
      if (!order?.fulfillments?.length) {
        result.push(
          addError(
            `missingFulfillments is mandatory for ${ApiSequence.ON_STATUS_PENDING}`,
            ERROR_CODES.ORDER_VALIDATION_FAILURE
          )
        );
      } else {
        const deliveryObjArr = order.fulfillments.filter(
          (f: any) => f?.type === "Delivery"
        );
        const selfPickupObjArr = order.fulfillments.filter(
          (f: any) => f?.type === "Self-Pickup"
        );
        if (flow !== "3" && !deliveryObjArr.length) {
          result.push(
            addError(
              `Delivery fulfillment must be present in ${ApiSequence.ON_STATUS_PENDING}`,
              ERROR_CODES.ORDER_VALIDATION_FAILURE
            )
          );
        }
        if (flow === "3" && selfPickupObjArr.length !== 1) {
          result.push(
            addError(
              `Exactly one Self-Pickup fulfillment must be present in ${ApiSequence.ON_STATUS_PENDING}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
        if (deliveryObjArr.length > 0) {
          try {
            let deliverObj = { ...deliveryObjArr[0] };
            deliverObj = structuredClone(deliverObj)
            delete deliverObj?.state;
            delete deliverObj?.tags;
            delete deliverObj?.start?.instructions;
            delete deliverObj?.end?.instructions;
            fulfillmentsItemsSet.add(deliverObj);
            await RedisService.setKey(
              `${transaction_id}_fulfillmentsItemsSet`,
              JSON.stringify([...fulfillmentsItemsSet]),
              TTL_IN_SECONDS
            );
          } catch {
            result.push(
              addError(
                `Error storing delivery fulfillment ID`,
                ERROR_CODES.INTERNAL_ERROR
              )
            );
          }
        }
      }
    }
  } catch {
    result.push(
      addError(
        `Internal error validating fulfillments`,
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateTimestamps(
  order: any,
  context: any,
  transaction_id: any,
  state: any,
  result: any
) {
  const cnfrmTmpstmpRaw = await RedisService.getKey(
    `${transaction_id}_cnfrmTmpstmp`
  );
  const cnfrmTmpstmp = cnfrmTmpstmpRaw ? JSON.parse(cnfrmTmpstmpRaw) : null;
  if (cnfrmTmpstmp && !_.isEqual(cnfrmTmpstmp, order.created_at)) {
    result.push(
      addError(
        `Created At timestamp for /${constants.ON_STATUS}_${state} should be equal to context timestamp at ${constants.CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const onCnfrmTmpstmpRaw = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.ON_CONFIRM}_tmpstmp`
  );
  const onCnfrmTmpstmp = onCnfrmTmpstmpRaw
    ? JSON.parse(onCnfrmTmpstmpRaw)
    : null;
  if (onCnfrmTmpstmp && _.gte(onCnfrmTmpstmp, context.timestamp)) {
    result.push(
      addError(
        `Timestamp for /${constants.ON_CONFIRM} api cannot be greater than or equal to /${constants.ON_STATUS}_${state} api`,
        ERROR_CODES.OUT_OF_SEQUENCE
      )
    );
  }

  if (!areTimestampsLessThanOrEqualTo(order.updated_at, context.timestamp)) {
    result.push(
      addError(
        `order.updated_at timestamp should be less than or equal to context timestamp for /${constants.ON_STATUS}_${state} api`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  await RedisService.setKey(
    `${transaction_id}_tmpstmp`,
    JSON.stringify(context.timestamp),
    TTL_IN_SECONDS
  );
}

async function validatePayment(
  order: any,
  transaction_id: any,
  flow: any,
  result: any,
  state: any
) {
  const prevPaymentRaw = await RedisService.getKey(
    `${transaction_id}_prevPayment`
  );
  const prevPayment = prevPaymentRaw ? JSON.parse(prevPaymentRaw) : null;
  console.log("order.payment", order.payment);
  if (prevPayment && !_.isEqual(prevPayment, order.payment)) {
    result.push(
      addError(
        `payment object mismatches with the previous action call and /${constants.ON_STATUS}_${state}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const buyerFFRaw = await RedisService.getKey(
    `${transaction_id}_buyerFFAmount`
  );
  const buyerFF = buyerFFRaw ? JSON.parse(buyerFFRaw) : null;
  if (
    buyerFF &&
    order.payment?.["@ondc/org/buyer_app_finder_fee_amount"] &&
    parseFloat(order.payment["@ondc/org/buyer_app_finder_fee_amount"]) !=
      buyerFF
  ) {
    result.push(
      addError(
        `Buyer app finder fee can't change in /${constants.ON_STATUS}_${state}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  if (flow !== FLOW.FLOW2A) {
    const status = payment_status(order.payment, flow);
    if (!status) {
      result.push(
        addError(
          `Transaction_id missing in message/order/payment`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  if (
    flow === FLOW.FLOW2A &&
    order.payment?.status !== PAYMENT_STATUS.NOT_PAID
  ) {
    result.push(
      addError(
        `Payment status should be ${PAYMENT_STATUS.NOT_PAID} (Cash on Delivery)`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  const settlement_details: any =
    order?.payment["@ondc/org/settlement_details"];

  const storedSettlementRaw = await RedisService.getKey(
    `${transaction_id}_settlementDetailSet`
  );

  const storedSettlementSet = storedSettlementRaw
    ? JSON.parse(storedSettlementRaw)
    : null;

  storedSettlementSet?.forEach((obj1: any) => {
    const exist = settlement_details.some((obj2: any) => _.isEqual(obj1, obj2));
    if (!exist) {
      result.push({
        valid: false,
        code: 20006,
        description: `Missing payment/@ondc/org/settlement_details as compared to previous calls or not captured correctly: ${JSON.stringify(
          obj1
        )}`,
      });
    }
  });
}

export function validateOfferQuoteBreakup(order: any, result: any[]): void {
  order.quote.breakup.forEach((item: any) => {
    if (item["@ondc/org/title_type"] !== "offer") return;

    const tags = item.item?.tags;
    if (!Array.isArray(tags)) {
      result.push(
        addError(`Missing or invalid 'item.tags' in offer item`, 20006)
      );
      return;
    }

    const requiredFinanceTerms = [
      "subvention_type",
      "subvention_amount",
      "provider_tax_number",
      "bank_account_no",
      "ifsc_code",
    ];

    const requiredFinanceTxn = [
      "loan_completed",
      "down_payment",
      "loan_amount",
      "loan_provider",
      "transaction_id",
      "timestamp",
    ];

    const tagMap = new Map<string, any[]>();
    tags.forEach((tag: any) => {
      if (tag.code && Array.isArray(tag.list)) {
        tagMap.set(tag.code, tag.list);
      }
    });

    const quoteList = tagMap.get("quote");
    if (!quoteList) {
      result.push(addError(`Missing 'quote' tag in item.tags`, 20006));
    } else if (
      !quoteList.some(
        (entry) => entry.code === "type" && entry.value === "item"
      )
    ) {
      result.push(
        addError(`Missing or invalid 'type: item' in quote tag`, 20006)
      );
    }

    const financeTerms = tagMap.get("finance_terms");
    if (!financeTerms) {
      result.push(addError(`Missing 'finance_terms' tag`, 20006));
    } else {
      requiredFinanceTerms.forEach((code) => {
        const entry = financeTerms.find((item) => item.code === code);
        if (!entry || !entry.value?.toString().trim()) {
          result.push(
            addError(`Missing or empty '${code}' in finance_terms`, 20006)
          );
        }
      });

      const subventionType = financeTerms.find(
        (f) => f.code === "subvention_type"
      )?.value;
      if (subventionType && !["percent", "amount"].includes(subventionType)) {
        result.push(
          addError(
            `Invalid 'subvention_type': must be 'percent' or 'amount'`,
            20006
          )
        );
      }

      const subventionAmount = financeTerms.find(
        (f) => f.code === "subvention_amount"
      )?.value;
      if (subventionAmount && isNaN(parseFloat(subventionAmount))) {
        result.push(
          addError(`Invalid 'subvention_amount': must be numeric`, 20006)
        );
      }
    }

    const financeTxn = tagMap.get("finance_txn");
    if (!financeTxn) {
      result.push(addError(`Missing 'finance_txn' tag`, 20006));
    } else {
      requiredFinanceTxn.forEach((code) => {
        const entry = financeTxn.find((item) => item.code === code);
        if (!entry || !entry.value?.toString().trim()) {
          result.push(
            addError(`Missing or empty '${code}' in finance_txn`, 20006)
          );
        }
      });

      const downPayment = financeTxn.find(
        (f) => f.code === "down_payment"
      )?.value;
      const loanAmount = financeTxn.find(
        (f) => f.code === "loan_amount"
      )?.value;

      if (downPayment && isNaN(parseFloat(downPayment))) {
        result.push(addError(`Invalid 'down_payment': must be numeric`, 20006));
      }

      if (loanAmount && isNaN(parseFloat(loanAmount))) {
        result.push(addError(`Invalid 'loan_amount': must be numeric`, 20006));
      }

      const timestamp = financeTxn.find((f) => f.code === "timestamp")?.value;
      if (timestamp && isNaN(Date.parse(timestamp))) {
        result.push(
          addError(
            `Invalid 'timestamp': must be valid ISO 8601 datetime`,
            20006
          )
        );
      }

      const loanCompleted = financeTxn.find(
        (f) => f.code === "loan_completed"
      )?.value;
      if (
        loanCompleted &&
        !["yes", "no"].includes(loanCompleted.toLowerCase())
      ) {
        result.push(
          addError(`'loan_completed' must be either 'yes' or 'no'`, 20006)
        );
      }
    }
  });
}
async function validateQuote(
  order: any,
  transaction_id: any,
  state: any,
  result: any
) {
  if (!sumQuoteBreakUp(order.quote)) {
    result.push(
      addError(
        `item quote breakup prices for ${constants.ON_STATUS}_${state} should be equal to the total price`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const quoteObjRaw = await RedisService.getKey(`${transaction_id}_quoteObj`);
  const previousQuote = quoteObjRaw ? JSON.parse(quoteObjRaw) : null;
  const quoteErrors = compareQuoteObjects(
    previousQuote,
    order.quote,
    constants.ON_STATUS,
    "previous action call"
  );

  if (quoteErrors) {
    quoteErrors.forEach((error: any) =>
      result.push(addError(error, ERROR_CODES.INVALID_RESPONSE))
    );
  }

  validateOfferQuoteBreakup(order, result);
}

async function validateBilling(
  order: any,
  transaction_id: any,
  state: any,
  result: any
) {
  const billingRaw = await RedisService.getKey(`${transaction_id}_billing`);
  const billing = billingRaw ? JSON.parse(billingRaw) : null;
  const billingErrors = billing && compareObjects(billing, order.billing);
  if (billingErrors) {
    billingErrors.forEach((error: any) =>
      result.push(
        addError(
          `${error} when compared with confirm billing object`,
          ERROR_CODES.INVALID_RESPONSE
        )
      )
    );
  }
}

async function validateTags(
  order: any,
  transaction_id: any,
  state: any,
  result: any
) {
  const bpp_terms_obj = order.tags?.find(
    (item: any) => item?.code === "bpp_terms"
  );
  const list = bpp_terms_obj?.list || [];
  const accept_bap_terms = list.filter(
    (item: any) => item.code === "accept_bap_terms"
  );
  const np_type_on_search = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.ON_SEARCH}np_type`
  );

  if (accept_bap_terms.length > 0) {
    result.push(
      addError(
        `accept_bap_terms is not required for now`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  let tax_number = "";
  let provider_tax_number = "";
  list.forEach((item: any) => {
    if (item.code === "tax_number") {
      if (item.value.length !== 15) {
        result.push(
          addError(
            `Number of digits in tax number in message.order.tags[0].list should be 15`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else {
        tax_number = item.value;
        const taxNumberPattern =
          /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        if (!taxNumberPattern.test(tax_number)) {
          result.push(
            addError(
              `Invalid format for tax_number in ${constants.ON_STATUS}_${state}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }
    if (item.code === "provider_tax_number") {
      if (item.value.length !== 10) {
        result.push(
          addError(
            `Number of digits in provider tax number in message.order.tags[0].list should be 10`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else {
        provider_tax_number = item.value;
        const taxNumberPattern = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
        if (!taxNumberPattern.test(provider_tax_number)) {
          result.push(
            addError(
              `Invalid format for provider_tax_number in ${constants.ON_STATUS}_${state}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }
  });

  if (tax_number.length === 15 && provider_tax_number.length === 10) {
    const pan_id = tax_number.slice(2, 12);
    if (pan_id !== provider_tax_number && np_type_on_search === "ISN") {
      result.push(
        addError(
          `Pan_id is different in tax_number and provider_tax_number in message.order.tags[0].list`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    } else if (pan_id === provider_tax_number && np_type_on_search === "MSN") {
      result.push(
        addError(
          `Pan_id shouldn't be same in tax_number and provider_tax_number in message.order.tags[0].list`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  const confirm_tagsRaw = await RedisService.getKey(
    `${transaction_id}_confirm_tags`
  );
  const confirm_tags = confirm_tagsRaw ? JSON.parse(confirm_tagsRaw) : null;
  if (order.tags && confirm_tags) {
    // if (!areGSTNumbersMatching(confirm_tags, order.tags, "bpp_terms")) {
    //   result.push(
    //     addError(
    //       `Tags should have same and valid gst_number as passed in /${constants.CONFIRM}`,
    //       ERROR_CODES.INVALID_RESPONSE
    //     )
    //   );
    // }
  }

  const list_ON_CONFIRM = bpp_terms_obj?.list || [];
  const list_ON_INITRaw = await RedisService.getKey(
    `${transaction_id}_list_ON_INIT`
  );
  const list_ON_INIT = list_ON_INITRaw ? JSON.parse(list_ON_INITRaw) : null;
  if (list_ON_INIT) {
    let ON_INIT_val = "";
    list_ON_INIT.forEach((data: any) => {
      if (data.code === "tax_number") ON_INIT_val = data.value;
    });
    list_ON_CONFIRM.forEach((data: any) => {
      if (
        data.code === "tax_number" &&
        ON_INIT_val &&
        data.value !== ON_INIT_val
      ) {
        result.push(
          addError(
            `Value of tax Number mismatched in message/order/tags/bpp_terms for ${constants.ON_INIT} and ${constants.ON_STATUS}_${state}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    });
  }
}

async function validateItems(
  transactionId: any,
  items: any,
  result: any,
  options: any = {
    currentApi: ApiSequence.ON_STATUS_PENDING,
    previousApi: ApiSequence.ON_CONFIRM,
    checkQuantity: true,
    checkTags: true,
    checkLocationId: true,
  }
) {
  const {
    currentApi = ApiSequence.ON_STATUS_PENDING,
    previousApi = ApiSequence.ON_CONFIRM,
    checkQuantity = true,
    checkTags = true,
    checkLocationId = true,
  } = options;

  try {
    if (!Array.isArray(items) || items.length === 0) {
      result.push({
        valid: false,
        code: ERROR_CODES.INVALID_RESPONSE,
        description: `items array is missing or empty in /${currentApi}`,
      });
      return result;
    }

    const redisKeys = [
      RedisService.getKey(`${transactionId}_itemFlfllmnts`),
      RedisService.getKey(`${transactionId}_itemsIdList`),
    ];

    if (checkLocationId) {
      redisKeys.push(RedisService.getKey(`${transactionId}_onSearchItems`));
    }

    const redisResults = await Promise.all(
      redisKeys.map(async (key: any, index: any) => {
        try {
          return await key;
        } catch (error: any) {
          console.error(
            `!!Error fetching Redis key ${index} for transaction ${transactionId}: ${error.message}`
          );
          return null;
        }
      })
    );

    const [itemFlfllmntsRaw, itemsIdListRaw, onSearchItemsRaw] = redisResults;

    const itemFlfllmnts = itemFlfllmntsRaw
      ? JSON.parse(itemFlfllmntsRaw)
      : null;
    let itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;

    const allOnSearchItems = onSearchItemsRaw
      ? JSON.parse(onSearchItemsRaw)
      : [];
    const onSearchItems = Array.isArray(allOnSearchItems)
      ? allOnSearchItems.flat()
      : [];

    let itemsCountChange = false;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemId = item?.id;

      if (!itemId || typeof itemId !== "string" || itemId.trim() === "") {
        console.info(
          `Missing or invalid item ID at index ${i} for transaction ${transactionId}`
        );
        result.push({
          valid: false,
          code: ERROR_CODES.INVALID_RESPONSE,
          description: `items[${i}].id is missing or invalid in /${currentApi}`,
        });
        continue;
      }

      if (!itemFlfllmnts || !(itemId in itemFlfllmnts)) {
        console.info(
          `Item Id ${itemId} does not exist in /${previousApi} for transaction ${transactionId}`
        );
        result.push({
          valid: false,
          code: ERROR_CODES.INVALID_RESPONSE,
          description: `Item Id ${itemId} does not exist in /${previousApi}`,
        });
        continue;
      }

      if (checkQuantity) {
        if (!item.quantity || item.quantity.count == null) {
          result.push({
            valid: false,
            code: ERROR_CODES.INVALID_RESPONSE,
            description: `items[${i}].quantity.count is missing or undefined for Item ${itemId} in /${currentApi}`,
          });
        } else if (
          !Number.isInteger(item.quantity.count) ||
          item.quantity.count < 0
        ) {
          result.push({
            valid: false,
            code: ERROR_CODES.INVALID_RESPONSE,
            description: `items[${i}].quantity.count must be a positive integer for Item ${itemId} in /${currentApi}`,
          });
        }
      }

      if (checkLocationId) {
        if (
          !item.location_id ||
          typeof item.location_id !== "string" ||
          item.location_id.trim() === ""
        ) {
          // console.info(`Missing or invalid location_id for item ID: ${itemId} at index ${i} for transaction ${transactionId}`);
          // result.push({
          //   valid: false,
          //   code: ERROR_CODES.INVALID_RESPONSE,
          //   description: `items[${i}]: location_id is required and must be a non-empty string in /${currentApi}`,
          // });
        }
      }
    }

    if (checkQuantity && itemsCountChange) {
      await RedisService.setKey(
        `${transactionId}_itemsIdList`,
        JSON.stringify(itemsIdList),
        TTL_IN_SECONDS
      );
    }

    return result;
  } catch (error: any) {
    result.push({
      valid: false,
      code: ERROR_CODES.INTERNAL_ERROR,
      description: `Error occurred while validating items in /${currentApi}`,
    });
    return result;
  }
}

const checkOnStatusPending = async (
  payload: any,
  state: any,
  fulfillmentsItemsSet: any
) => {
  const result: any = [];

  try {
    const data = structuredClone(payload)
    const { context, message } = data;
    try {
      await contextChecker(
        context,
        result,
        constants.ON_STATUS_PENDING,
        constants.ON_CONFIRM,
        true
      );
    } catch (err: any) {
      result.push(addError(`Error checking context: ${err.message}`, 20000));

      return result;
    }

    const flow = "2";

    const onConfirmOrderState = await RedisService.getKey(
      `${context.transaction_id}_${ApiSequence.ON_CONFIRM}_orderState`
    );

    if (onConfirmOrderState === "Accepted") {
      result.push({
        valid: false,
        code: ERROR_CODES.INVALID_ORDER_STATE,
        description: `When the onConfirm Order State is 'Accepted', the on_status_pending is not required!`,
      });
      return result;
    }

    const { transaction_id } = context;
    const order = message.order;

    await Promise.all([
      validateOrder(order, transaction_id, state, result),
      validateFulfillments(
        order,
        transaction_id,
        state,
        fulfillmentsItemsSet,
        result
      ),
      validateTimestamps(order, context, transaction_id, state, result),
      validatePayment(order, transaction_id, flow, result, state),
      validateQuote(order, transaction_id, state, result),
      validateBilling(order, transaction_id, state, result),
      validateItems(transaction_id, order.items, result, {
        currentApi: ApiSequence.ON_STATUS_PENDING,
        previousApi: ApiSequence.ON_CONFIRM,
        checkQuantity: true,
        checkTags: true,
        checkLocationId: true,
      }),
      validateTags(order, transaction_id, state, result),
      RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_STATUS_PENDING}`,
        JSON.stringify(data),
        TTL_IN_SECONDS
      ),
    ]);

    return result;
  } catch (err: any) {
    console.error(
      `!!Some error occurred while checking /${constants.ON_STATUS} API, ${err.stack}`
    );
    result.push(
      addError(
        "Internal Error - The response could not be processed due to an internal error. The SNP should retry the request.",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
    return result;
  }
};

export default checkOnStatusPending;
