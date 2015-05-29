function parseAddressFromComment(comment) {
  return (comment.body || '').trim();
}

module.exports = {
  disbursementRatio: 0.10,
  multisigM: 1,
  buildPlan: function() {
    return this.getFunds().then(function(funds) {
      return this.getBeneficiaries().then(function(beneficiaries) {
        var disbursement = funds.balance * this.disbursementRatio;
        var paymentSize = disbursement / beneficiaries.length;
        disbursement = paymentSize * beneficiaries.length;
        if (paymentSize <= 0 || disbursement > funds.balance) {throw 'Insufficient funds';}
        // TODO miner fee calculation
        return {
          funds: funds,
          disbursement: disbursement,
          change: funds.balance - disbursement,
          paymentSize: paymentSize,
          beneficiaries: beneficiaries
        };
      });
    });
  },
  getSignedTransaction: function() {
    var multisigM = this.multisigM;
    return this.getSignatures().then(function(res) {
      if (res.signatures.length < multisigM) {return;}
      // TODO : Build signed transaction
    });
  },
  getSignatures: function() {
    return this.getTransactionComment().then(function(comment) {
      var transaction = comment.body;
      function isValidSignature(text) {
        return true;
      }
      return bot.getReplies(comment.name).then(function(replies) {
        return _.mapBy(replies, 'body').filter(isValidSignature);
      }).then(function(signatures) {
        return {
          transaction: transaction,
          signatures: signatures
        };
      });
    }.bind(this));
  },
  getBeneficiaries: function() {
    return this.getTopLevelComments().then(function(comments) {
      return _.compact(comments.map(function(comment) {
        var address = parseAddressFromComment(comment);
        if (!address) {return;}
        return {
          address: address,
          id: comment.author
        };
      }));
    }).then(function(items) {
      var grouped = _.groupBy(items, 'id');
      return _.keys(grouped).map(function(id) {return _.first(grouped[id]);});
    });
  },
  getTransactionComment: function() {
    return this.getTopLevelComments().then(function(comments) {
      return _.find(comments, function(comment) {return comment.author === bot.user;});
    });
  },
  validateTransaction: function() {
    return this.buildPlan().then(function(plan) {
      return this.getTransactionComment().then(function(tc) {
        plan.comment = tc; // TODO : parse
        return plan;
      });
    }.bind(this)).then(function(plan) {
      plan.beneficiaries.forEach(function(beneficiary) {
        // Check transaction
        if (false) {throw 'Beneficiary missing';}
      });
      return plan;
    });
  },
  signTransaction: function() {
    return this.validateTransaction().then(function(plan) {
      // TODO: Build signature
      return bot.comment(plan.comment.name, signature);
    });
  }
};