const {writeFile, readFile} = require('fs')
const serialize = require('serialization')
const trainTestSplit = require('train-test-split')
const {Spinner} = require('clui')
const {PrecisionRecall, partitions, test} = require('limdu').utils
const labelDS = require('./src/conv')('io')
const classifierBuilder = require('./src/classifier')
const evaluate = require('./src/evaluate')
const categories = require('./src/categories')

class Learner {
  /**
   * @param {Object} opts Options.
   * @param {Object[]} [opts.dataset=require('./src/conv')('io')] Dataset (for training and testing)
   * @param {number} [trainSplit=.8] Dataset split percentage for the training set
   * @param {function(): Object} [classifier=classifierBuilder] Classifier builder function
   */
  constructor({
    dataset = labelDS,
    trainSplit = 0.8,
    classifier = classifierBuilder,
  } = {}) {
    this.dataset = dataset
    const [train, _test] = trainTestSplit(dataset, trainSplit)
    this.trainSplit = trainSplit
    this.trainSet = train
    this.testSet = _test
    this.classifier = classifier()
    this.classifierBuilder = classifier
  }

  train(trainSet = this.trainSet) {
    const training = new Spinner('Training...', [
      '⣾',
      '⣽',
      '⣻',
      '⢿',
      '⡿',
      '⣟',
      '⣯',
      '⣷',
    ])
    training.start()
    this.classifier.trainBatch(trainSet)
    training.message('Training complete')
    training.stop()
  }

  eval(log = false) {
    return evaluate({
      classifier: this.classifier,
      test: this.testSet,
      train: this.trainSet,
      log,
    })
  }

  serializeClassifier() {
    return serialize.toString(this.classifier, this.classifierBuilder)
  }

  serializeAndSaveClassifier(file = 'classifier.json') {
    return new Promise((resolve, reject) => {
      const data = this.serializeClassifier()
      writeFile(file, data, err => {
        if (err) reject(err)
        resolve(data)
      })
    })
  }

  deserializeClassifier(serializedClassifier) {
    return serialize.fromString(serializedClassifier, __dirname)
  }

  loadAndDeserializeClassifier(file = 'classifier.json') {
    return new Promise((resolve, reject) => {
      readFile(file, 'utf8', (err, data) => {
        if (err) reject(err)
        const classifier = this.deserializeClassifier(data)
        resolve(classifier)
      })
    })
  }

  classify(data) {
    return this.classifier.classify(data)
  }

  crossValidate(numOfFolds = 5, verboseLevel = 0, log = false) {
    /* ML Reminder (https://o.quizlet.com/Xc3kmIUi19opPDYn3hTo3A.png)
    T: True     F: False
    P: Positive N: Negative

    Precision (Pr, PPV): TP / (TP + FP) <=> TP / predictedP
    Recall (R, TPR): TP / (TP + FN) <=> TP / actualP
    Accuracy (A): (TP + TN) / Total
    Specificity (S, TNR): TN / (FP + TN) <=> TN / actualN
    F_1 (or effectiveness)  = 2 * (Pr * R) / (Pr + R)
    ...
    */
    this.macroAvg = new PrecisionRecall()
    this.microAvg = new PrecisionRecall()

    partitions.partitions(this.dataset, numOfFolds, (trainSet, testSet) => {
      if (log)
        process.stdout.write(
          `Training on ${trainSet.length} samples, testing ${
            testSet.length
          } samples`,
        )
      this.train(trainSet)
      test(this.classifier, testSet, verboseLevel, this.microAvg, this.macroAvg)
    })
    this.macroAvg.calculateMacroAverageStats(numOfFolds)
    this.microAvg.calculateStats()
    return {
      macroAvg: this.macroAvg.fullStats(), //preferable in 2-class settings or in balanced multi-class settings
      microAvg: this.microAvg.fullStats(), //preferable in multi-class settings (in case of class imbalance)
      //https://pdfs.semanticscholar.org/1d10/6a2730801b6210a67f7622e4d192bb309303.pdf and https://datascience.stackexchange.com/a/24051/73511
    }
  }

  backClassify(category) {
    return this.classifier.backClassify(category)
  }

  toJSON() {
    const classifier = this.serializeClassifier()
    const json = {
      classifier,
      classifierBuilder: this.classifierBuilder,
      dataset: this.dataset,
      trainSplit: this.trainSplit,
      trainSet: this.trainSet,
      testSet: this.testSet,
    }
    if (this.macroAvg) json.macroAvg = this.macroAvg
    if (this.microAvg) json.microAvg = this.microAvg
    return json
  }

  static fromJSON(json) {
    const ALLOWED_PROPS = [
      'classifierBuilder',
      /* 'dataset', 'trainSplit', */ 'trainSet',
      'testSet',
      'macroAvg',
      'microAvg',
    ]
    const newLearner = new Learner({
      dataset: json.dataset,
      trainSplit: json.trainSplit,
    })
    for (const prop in json) {
      if (ALLOWED_PROPS.includes(prop)) newLearner[prop] = json[prop]
    }

    newLearner.classifier = newLearner.deserializeClassifier(json.classifier)
    return newLearner
  }

  getCategoryPartition() {
    const res = {}
    categories.forEach(cat => {
      res[cat] = {
        overall: 0,
        test: 0,
        train: 0,
      }
    })
    this.dataset.forEach(data => {
      ++res[data.output].overall
      if (this.trainSet.includes(data)) ++res[data.output].train
      if (this.testSet.includes(data)) ++res[data.output].test
    })
    return res
  }

  getStats() {
    //@todo use C3.js for a stacked baar chart
    const {
      TP,
      TN,
      FP,
      FN,
      Precision,
      Accuracy,
      Recall,
      F1,
      count,
      confusion,
    } = this.microAvg
    return {
      TP,
      TN,
      FP,
      FN,
      confusion,
      Precision,
      Accuracy,
      Recall,
      F1,
      Specificity: TN / (FP + TN),
      totalCount: count,
      trainCount: this.trainSet.length,
      testCount: this.testSet.length,
      categoryPartition: this.getCategoryPartition(),
      //ROC, AUC
    }
  }
  /*
    @todo add the ability to get:
    - diagrams of categories based on what its training and testing sets
    - [WIP] confusion matrix (cf. utils.PrecisionRecall()) //cf. https://github.com/erelsgl/limdu/issues/63
    - ROC/AUC graphs
    @todo use utils.PrecisionRecall.Accuracy instead of doing that manually //waiting on ^
    @todo add randomization feature to limdu's partitions (with trainTestSplit as example) and fix typos //cf. https://github.com/erelsgl/limdu/issues/65
  */
}

module.exports = Learner
